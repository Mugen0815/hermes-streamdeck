import { randomUUID } from "node:crypto";

import type { HermesClient } from "../hermes/client";
import { HermesError, describeError } from "../hermes/errors";
import type { ApprovalChoice, StartRunRequest } from "../hermes/types";
import { isActivePhase, isTerminalPhase, type RunPhase, type RunSnapshot } from "./state";
import { RunTracker, type TrackerOptions } from "./tracker";

/**
 * What a Start Run key persists in its action settings so the state survives a Stream Deck restart.
 * Contains no secrets and no prompt output.
 */
export type PersistedRun = {
	runId: string;
	phase: RunPhase;
	startedAt?: number;
	endedAt?: number;
	denied?: boolean;
	resultFile?: string;
};

export type StartOutcome = "started" | "busy" | "failed";
export type StopOutcome = "requested" | "already_stopping" | "no_run" | "failed";
export type ApprovalOutcome = "answered" | "not_pending" | "not_allowed" | "failed";
export type SteerOutcome = "queued" | "no_run" | "not_running" | "not_accepted" | "failed";

export type RunManagerOptions = {
	client: () => HermesClient;
	/** Persist (or clear) the run of a key. */
	persist: (keyId: string, run: PersistedRun | undefined) => void;
	onChange: (keyId: string, snapshot: RunSnapshot) => void;
	/**
	 * Called once when a run tracked in this session ends. `request` is undefined for runs restored
	 * after a restart (the resolved prompt is not persisted).
	 */
	onFinished?: (keyId: string, snapshot: RunSnapshot, request: StartRunRequest | undefined) => void;
	tracker?: TrackerOptions;
	/** Delay before the single retry of a run start after a transient error. */
	startRetryDelayMs?: number;
	log?: (message: string) => void;
	now?: () => number;
};

type Entry = {
	snapshot: RunSnapshot;
	tracker?: RunTracker;
	request?: StartRunRequest;
};

/**
 * Owns the runs of all Start Run keys, keyed by the Stream Deck action instance id.
 * Each key has at most one run; a new start is refused while that run is active.
 */
export class RunManager {
	readonly #entries = new Map<string, Entry>();
	readonly #opts: RunManagerOptions;
	readonly #log: (message: string) => void;
	readonly #now: () => number;
	#lastStartedKey: string | undefined;

	constructor(options: RunManagerOptions) {
		this.#opts = options;
		this.#log = options.log ?? (() => {});
		this.#now = options.now ?? Date.now;
	}

	snapshot(keyId: string): RunSnapshot {
		return this.#entries.get(keyId)?.snapshot ?? { phase: "idle" };
	}

	/** Key id of the most recently started run (for Stop keys without an explicit target). */
	get lastStartedKey(): string | undefined {
		return this.#lastStartedKey;
	}

	/**
	 * Restores a key after the plugin (re)started. Terminal states are shown as persisted; active runs
	 * are re-checked against the server — a run the server no longer knows becomes `lost`, never `completed`.
	 */
	restore(keyId: string, persisted: PersistedRun | undefined): void {
		if (this.#entries.has(keyId)) return; // already tracked in this plugin session
		if (!persisted?.runId) return;

		if (isTerminalPhase(persisted.phase)) {
			this.#entries.set(keyId, {
				snapshot: { phase: persisted.phase, runId: persisted.runId, startedAt: persisted.startedAt, endedAt: persisted.endedAt, denied: persisted.denied, resultFile: persisted.resultFile },
			});
			return;
		}
		const entry: Entry = { snapshot: { phase: "checking", runId: persisted.runId, startedAt: persisted.startedAt } };
		this.#entries.set(keyId, entry);
		this.#emit(keyId);
		this.#track(keyId, entry, persisted.runId, "checking");
	}

	/**
	 * Starts exactly one run for the key. The "starting" state is set synchronously, so rapid repeated
	 * presses are refused as `busy` before any network call.
	 */
	async start(keyId: string, request: StartRunRequest): Promise<StartOutcome> {
		const current = this.#entries.get(keyId);
		if (current && isActivePhase(current.snapshot.phase)) return "busy";

		current?.tracker?.dispose();
		const entry: Entry = { snapshot: { phase: "starting", startedAt: this.#now() }, request };
		this.#entries.set(keyId, entry);
		this.#emit(keyId);

		const client = this.#opts.client();
		if (!client.configured) return this.#startFailed(keyId, entry, new HermesError("not_configured", "not configured"));
		if (request.input.trim() === "") return this.#startFailed(keyId, entry, undefined, "No prompt");

		const idempotencyKey = `streamdeck-${randomUUID()}`;
		let result;
		try {
			result = await this.#startWithRetry(client, request, idempotencyKey);
		} catch (err) {
			this.#log(`start failed for key ${keyId}: ${err instanceof Error ? err.message : String(err)}`);
			return this.#startFailed(keyId, entry, err);
		}
		if (this.#entries.get(keyId) !== entry) return "started"; // key was reset meanwhile

		this.#log(`run ${result.runId} started for key ${keyId}${result.replayed ? " (replayed)" : ""}`);
		entry.snapshot = { phase: "running", runId: result.runId, startedAt: entry.snapshot.startedAt };
		this.#lastStartedKey = keyId;
		this.#persist(keyId, entry);
		this.#emit(keyId);
		this.#track(keyId, entry, result.runId, "running");
		return "started";
	}

	/** Requests a stop for the key's run. The run is only reported stopped once Hermes confirms it. */
	async stop(keyId: string): Promise<StopOutcome> {
		const entry = this.#entries.get(keyId);
		const runId = entry?.snapshot.runId;
		if (!entry || !runId || !isActivePhase(entry.snapshot.phase)) return "no_run";
		if (entry.snapshot.phase === "stopping") return "already_stopping";

		const previous = entry.snapshot.phase;
		entry.tracker?.markStopping();
		if (!entry.tracker) this.#update(keyId, entry, { phase: "stopping" });

		try {
			await this.#opts.client().stopRun(runId);
			this.#log(`stop requested for run ${runId}`);
			entry.tracker?.nudge();
			return "requested";
		} catch (err) {
			if (err instanceof HermesError && err.kind === "not_found") {
				entry.tracker?.nudge(); // reconcile will mark the run as lost
				return "failed";
			}
			this.#log(`stop failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
			entry.tracker?.revertStopping(previous);
			return "failed";
		}
	}

	/**
	 * Answers the approval the key's run is waiting for. The request id must match the pending
	 * request, so an answer given for one request can never resolve a different one.
	 */
	async respondApproval(keyId: string, requestId: string | undefined, choice: ApprovalChoice): Promise<ApprovalOutcome> {
		const entry = this.#entries.get(keyId);
		const runId = entry?.snapshot.runId;
		const pending = entry?.snapshot.approval;
		if (!entry || !runId || entry.snapshot.phase !== "approval" || !pending) return "not_pending";
		if ((pending.requestId ?? "") !== (requestId ?? "")) return "not_pending";
		if (!pending.choices.includes(choice)) return "not_allowed";

		try {
			await this.#opts.client().respondApproval(runId, choice, requestId);
		} catch (err) {
			entry.tracker?.nudge();
			if (err instanceof HermesError && err.kind === "conflict") return "not_pending";
			this.#log(`approval answer for run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`);
			return "failed";
		}
		this.#log(`approval for run ${runId} answered: ${choice}`);
		entry.tracker?.markAnswered(requestId, choice === "deny");
		entry.tracker?.nudge();
		return "answered";
	}

	/**
	 * Sends steer text to the key's run. Hermes only accepts it while the run is `running`; the text
	 * is then queued and reaches the agent at its next tool boundary.
	 */
	async steer(keyId: string, text: string): Promise<SteerOutcome> {
		const entry = this.#entries.get(keyId);
		const runId = entry?.snapshot.runId;
		if (!entry || !runId || !isActivePhase(entry.snapshot.phase)) return "no_run";
		if (entry.snapshot.phase !== "running") return "not_running";

		try {
			await this.#opts.client().steerRun(runId, text);
		} catch (err) {
			if (err instanceof HermesError && err.kind === "conflict") {
				entry.tracker?.nudge(); // our view of the run is probably stale
				return err.code === "steer_not_accepted" ? "not_accepted" : "not_running";
			}
			if (err instanceof HermesError && err.kind === "not_found") {
				entry.tracker?.nudge();
				return "no_run";
			}
			this.#log(`steer for run ${runId} failed: ${err instanceof Error ? err.message : String(err)}`);
			return "failed";
		}
		this.#log(`steer queued for run ${runId}`);
		return "queued";
	}

	/** Records the result file of a finished run (persisted, so a press after a restart still opens it). */
	attachResult(keyId: string, runId: string, path: string): void {
		const entry = this.#entries.get(keyId);
		if (!entry || entry.snapshot.runId !== runId) return;
		entry.snapshot = { ...entry.snapshot, resultFile: path };
		this.#persist(keyId, entry);
		this.#emit(keyId);
	}

	/** Marks a key as failed before any request was sent (e.g. empty clipboard). */
	failBeforeStart(keyId: string, detail: string): void {
		const current = this.#entries.get(keyId);
		if (current && isActivePhase(current.snapshot.phase)) return;
		current?.tracker?.dispose();
		this.#entries.set(keyId, { snapshot: { phase: "start_failed", detail, endedAt: this.#now() } });
		this.#opts.persist(keyId, undefined);
		this.#emit(keyId);
	}

	/** Clears a finished run so the key shows "ready" again. Active runs are left untouched. */
	reset(keyId: string): void {
		const entry = this.#entries.get(keyId);
		if (!entry || isActivePhase(entry.snapshot.phase)) return;
		this.#entries.delete(keyId);
		this.#opts.persist(keyId, undefined);
		this.#emit(keyId);
	}

	/** Stops background tracking (plugin shutdown / tests). */
	dispose(): void {
		for (const entry of this.#entries.values()) entry.tracker?.dispose();
	}

	async #startWithRetry(client: HermesClient, request: StartRunRequest, idempotencyKey: string) {
		try {
			return await client.startRun(request, idempotencyKey);
		} catch (err) {
			// Same idempotency key: if the first request reached Hermes, this returns the same run.
			if (!(err instanceof HermesError) || !err.transient) throw err;
			await new Promise((resolve) => setTimeout(resolve, this.#opts.startRetryDelayMs ?? 1_000));
			return await client.startRun(request, idempotencyKey);
		}
	}

	#startFailed(keyId: string, entry: Entry, err: unknown, detail?: string): StartOutcome {
		if (this.#entries.get(keyId) === entry) {
			entry.snapshot = { phase: "start_failed", detail: detail ?? describeError(err), endedAt: this.#now() };
			this.#opts.persist(keyId, undefined);
			this.#emit(keyId);
		}
		return "failed";
	}

	#track(keyId: string, entry: Entry, runId: string, phase: RunPhase): void {
		let finished = false;
		const tracker = new RunTracker(
			runId,
			phase,
			this.#opts.client,
			(update) => {
				if (this.#entries.get(keyId) !== entry) return;
				const terminal = isTerminalPhase(update.phase);
				this.#update(keyId, entry, {
					phase: update.phase,
					reconnecting: update.reconnecting,
					detail: update.detail,
					endedAt: terminal ? (entry.snapshot.endedAt ?? this.#now()) : undefined,
					approval: update.approval,
					denied: update.denied || undefined,
					output: update.output,
					error: update.error,
					pendingSteer: update.pendingSteer,
				});
				if (terminal && !finished) {
					finished = true;
					this.#log(`run ${runId} ended: ${update.phase}`);
					this.#opts.onFinished?.(keyId, entry.snapshot, entry.request);
				}
			},
			{ log: this.#log, ...this.#opts.tracker },
		);
		entry.tracker = tracker;
		void tracker.run().catch((err) => this.#log(`tracker ${runId} crashed: ${String(err)}`));
	}

	#update(keyId: string, entry: Entry, patch: Partial<RunSnapshot>): void {
		const before = entry.snapshot.phase;
		entry.snapshot = { ...entry.snapshot, ...patch };
		if (entry.snapshot.phase !== before) this.#persist(keyId, entry);
		this.#emit(keyId);
	}

	#persist(keyId: string, entry: Entry): void {
		const { runId, phase, startedAt, endedAt, denied, resultFile } = entry.snapshot;
		if (!runId) return;
		this.#opts.persist(keyId, { runId, phase, startedAt, endedAt, ...(denied ? { denied } : {}), ...(resultFile ? { resultFile } : {}) });
	}

	#emit(keyId: string): void {
		this.#opts.onChange(keyId, this.snapshot(keyId));
	}
}
