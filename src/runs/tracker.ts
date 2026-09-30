import { type HermesClient, parseApproval } from "../hermes/client";
import { HermesError, describeError } from "../hermes/errors";
import type { PendingApproval, RunEvent } from "../hermes/types";
import { applyEvent, isTerminalPhase, mergeStatus, type RunPhase } from "./state";

export type TrackerUpdate = {
	phase: RunPhase;
	reconnecting: boolean;
	detail?: string;
	/** The approval Hermes is currently waiting for, if any. */
	approval?: PendingApproval;
	/** True once any approval of this run was denied (the run may still end as "completed"). */
	denied: boolean;
	/** Final answer / error text once the run is terminal. */
	output?: string;
	error?: string;
	/** Accepted steer text the agent never received. */
	pendingSteer?: string;
};

export type TrackerOptions = {
	/** Poll interval when the event stream is unavailable (e.g. Hermes dropped the event buffer). */
	pollIntervalMs?: number;
	/** Delays between reconnect attempts after errors; the last value repeats. */
	backoffMs?: number[];
	/** Pause before re-opening a stream that closed without a terminal event. */
	reopenDelayMs?: number;
	log?: (message: string) => void;
};

type ClientSource = () => HermesClient;

/**
 * Follows one run until it reaches a terminal state.
 *
 * Strategy: reconcile with `GET /v1/runs/{id}` first, then follow the SSE stream (resuming with
 * `Last-Event-ID`). Whenever the stream ends or fails without a terminal event, reconcile again.
 * If the stream endpoint returns 404 (Hermes discards event buffers of unobserved runs after a few
 * minutes) the tracker falls back to polling the status endpoint.
 */
export class RunTracker {
	readonly runId: string;
	#state: TrackerUpdate;
	#lastEventId: string | undefined;
	#sseAvailable = true;
	#failures = 0;
	#disposed = false;
	#abort = new AbortController();
	readonly #client: ClientSource;
	readonly #onUpdate: (update: TrackerUpdate) => void;
	readonly #pollIntervalMs: number;
	readonly #backoffMs: number[];
	readonly #reopenDelayMs: number;
	readonly #log: (message: string) => void;

	constructor(runId: string, initialPhase: RunPhase, client: ClientSource, onUpdate: (update: TrackerUpdate) => void, options: TrackerOptions = {}) {
		this.runId = runId;
		this.#state = { phase: initialPhase, reconnecting: false, denied: false };
		this.#client = client;
		this.#onUpdate = onUpdate;
		this.#pollIntervalMs = options.pollIntervalMs ?? 3_000;
		this.#backoffMs = options.backoffMs ?? [1_000, 2_000, 5_000, 10_000, 15_000];
		this.#reopenDelayMs = options.reopenDelayMs ?? 1_000;
		this.#log = options.log ?? (() => {});
	}

	get phase(): RunPhase {
		return this.#state.phase;
	}

	get approval(): PendingApproval | undefined {
		return this.#state.approval;
	}

	/** Runs the tracking loop; resolves once the run is terminal or the tracker is disposed. */
	async run(): Promise<void> {
		while (!this.#disposed && !isTerminalPhase(this.#state.phase)) {
			if (!(await this.#reconcile())) {
				await this.#sleep(this.#backoff());
				continue;
			}
			if (isTerminalPhase(this.#state.phase) || this.#disposed) break;

			if (!this.#sseAvailable) {
				await this.#sleep(this.#pollIntervalMs);
				continue;
			}
			await this.#follow();
		}
	}

	/** Marks a locally requested stop so stale `running` updates do not hide it. */
	markStopping(): void {
		if (isTerminalPhase(this.#state.phase)) return;
		this.#patch({ phase: "stopping" });
	}

	/** Restores the phase after a failed stop request. */
	revertStopping(phase: RunPhase): void {
		if (this.#state.phase === "stopping") this.#patch({ phase });
	}

	/** Records an approval answer sent by this plugin (the event stream confirms it as well). */
	markAnswered(requestId: string | undefined, denied: boolean): void {
		const pending = this.#state.approval;
		const matches = !pending || !requestId || !pending.requestId || pending.requestId === requestId;
		this.#patch({
			approval: matches ? undefined : pending,
			denied: this.#state.denied || denied,
			phase: this.#state.phase === "approval" && matches ? "running" : this.#state.phase,
		});
	}

	/** Triggers an immediate reconcile (e.g. after a stop request) by interrupting the current wait/stream. */
	nudge(): void {
		const previous = this.#abort;
		this.#abort = new AbortController();
		previous.abort();
	}

	dispose(): void {
		this.#disposed = true;
		this.#abort.abort();
	}

	async #reconcile(): Promise<boolean> {
		try {
			const info = await this.#client().getRun(this.runId);
			this.#failures = 0;
			const phase = mergeStatus(this.#state.phase, info.status);
			this.#patch({
				phase,
				reconnecting: false,
				detail: undefined,
				// The status carries the pending request; any other status means nothing is pending.
				approval: phase === "approval" ? (info.approval ?? this.#state.approval) : undefined,
				...(isTerminalPhase(phase)
					? { output: info.output ?? this.#state.output, error: info.error ?? this.#state.error, pendingSteer: info.pendingSteer ?? this.#state.pendingSteer }
					: {}),
			});
			return true;
		} catch (err) {
			if (this.#disposed) return true;
			if (err instanceof HermesError && err.kind === "not_found") {
				this.#log(`run ${this.runId} no longer known to server`);
				this.#patch({ phase: "lost", reconnecting: false, detail: "run unknown", approval: undefined });
				return true;
			}
			this.#failures++;
			this.#log(`reconcile ${this.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
			this.#patch({ reconnecting: true, detail: describeError(err) });
			return false;
		}
	}

	async #follow(): Promise<void> {
		const signal = this.#abort.signal;
		const stream = new AbortController();
		const onAbort = () => stream.abort();
		signal.addEventListener("abort", onAbort, { once: true });

		try {
			await this.#client().streamEvents(this.runId, {
				lastEventId: this.#lastEventId,
				signal: stream.signal,
				onEvent: (event) => {
					if (event.id !== undefined) this.#lastEventId = event.id;
					this.#onEvent(event);
					if (isTerminalPhase(this.#state.phase)) stream.abort();
				},
			});
			// Stream closed by the server (or by us after a terminal event). Loop reconciles next.
			if (!isTerminalPhase(this.#state.phase) && !signal.aborted) await this.#sleep(this.#reopenDelayMs);
		} catch (err) {
			if (this.#disposed) return;
			if (err instanceof HermesError && err.kind === "not_found") {
				this.#log(`event stream for ${this.runId} unavailable, falling back to polling`);
				this.#sseAvailable = false;
				return;
			}
			this.#failures++;
			this.#log(`event stream ${this.runId} failed: ${err instanceof Error ? err.message : String(err)}`);
			await this.#sleep(this.#backoff());
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#onEvent(event: RunEvent): void {
		const phase = applyEvent(this.#state.phase, event);
		const patch: Partial<TrackerUpdate> = { phase, reconnecting: false, detail: this.#state.reconnecting ? undefined : this.#state.detail };

		if (event.event === "approval.request") {
			patch.approval = parseApproval(event.payload) ?? this.#state.approval;
		} else if (event.event === "approval.responded") {
			const requestId = typeof event.payload.request_id === "string" ? event.payload.request_id : undefined;
			const pending = this.#state.approval;
			if (!pending || !requestId || pending.requestId === requestId) patch.approval = undefined;
			if (event.payload.choice === "deny") patch.denied = true;
		} else if (phase !== "approval") {
			patch.approval = undefined;
		}
		if (isTerminalPhase(phase)) {
			patch.approval = undefined;
			if (typeof event.payload.output === "string") patch.output = event.payload.output;
			if (typeof event.payload.pending_steer === "string" && event.payload.pending_steer) patch.pendingSteer = event.payload.pending_steer;
			const error = event.payload.error;
			if (typeof error === "string") patch.error = error;
			else if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") patch.error = (error as { message: string }).message;
		}
		this.#patch(patch);
	}

	#patch(patch: Partial<TrackerUpdate>): void {
		if (this.#disposed) return;
		const next: TrackerUpdate = { ...this.#state, ...patch };
		const prev = this.#state;
		this.#state = next;
		const changed =
			next.phase !== prev.phase ||
			next.reconnecting !== prev.reconnecting ||
			next.detail !== prev.detail ||
			next.denied !== prev.denied ||
			next.approval?.requestId !== prev.approval?.requestId ||
			next.approval?.command !== prev.approval?.command ||
			(next.approval === undefined) !== (prev.approval === undefined);
		if (changed) this.#onUpdate({ ...next });
	}

	#backoff(): number {
		const index = Math.min(Math.max(this.#failures - 1, 0), this.#backoffMs.length - 1);
		return this.#backoffMs[index] ?? 5_000;
	}

	#sleep(ms: number): Promise<void> {
		const signal = this.#abort.signal;
		return new Promise((resolve) => {
			if (signal.aborted) return resolve();
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			}
			signal.addEventListener("abort", done, { once: true });
		});
	}
}
