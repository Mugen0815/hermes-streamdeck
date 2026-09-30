import { HermesError, fromFetchError } from "./errors";
import { SseParser } from "./sse";
import {
	APPROVAL_CHOICES,
	type ApprovalChoice,
	type Capabilities,
	type HealthInfo,
	type PendingApproval,
	type RunEvent,
	type RunInfo,
	type StartRunRequest,
	type StartRunResult,
} from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HermesClientOptions = {
	baseUrl: string;
	apiKey: string;
	/** Timeout for regular (non-streaming) requests. */
	timeoutMs?: number;
	/** Abort an event stream when no bytes (not even keepalive comments) arrive for this long. */
	streamIdleTimeoutMs?: number;
	fetch?: FetchLike;
};

export type StreamOptions = {
	lastEventId?: string;
	signal?: AbortSignal;
	onEvent: (event: RunEvent) => void;
};

/**
 * Thin HTTP client for the Hermes API server. All Hermes-specific paths, headers and payload
 * shapes live here; callers only see typed results and {@link HermesError}s.
 */
export class HermesClient {
	readonly baseUrl: string;
	readonly #apiKey: string;
	readonly #timeoutMs: number;
	readonly #streamIdleTimeoutMs: number;
	readonly #fetch: FetchLike;

	constructor(options: HermesClientOptions) {
		this.baseUrl = normalizeBaseUrl(options.baseUrl);
		this.#apiKey = options.apiKey.trim();
		this.#timeoutMs = options.timeoutMs ?? 10_000;
		this.#streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? 35_000;
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
	}

	get configured(): boolean {
		return this.baseUrl !== "" && this.#apiKey !== "";
	}

	/** `GET /health` — no authentication required. */
	async health(): Promise<HealthInfo> {
		const body = await this.#json("GET", "/health", { auth: false });
		if (typeof body.status !== "string") throw new HermesError("bad_response", "Health response without status");
		return {
			status: body.status,
			version: typeof body.version === "string" ? body.version : undefined,
			platform: typeof body.platform === "string" ? body.platform : undefined,
		};
	}

	/** `GET /v1/capabilities` — requires a valid API key, so it doubles as an auth check. */
	async capabilities(): Promise<Capabilities> {
		const body = await this.#json("GET", "/v1/capabilities");
		const auth = body.auth as { type?: unknown } | undefined;
		return {
			authType: typeof auth?.type === "string" ? auth.type : undefined,
			features: isRecord(body.features) ? body.features : {},
		};
	}

	/**
	 * `POST /v1/runs`. The idempotency key makes a retry after a lost response return the same run
	 * instead of starting a second one (Hermes keeps keys for 24 h).
	 */
	async startRun(request: StartRunRequest, idempotencyKey: string): Promise<StartRunResult> {
		const payload: Record<string, string> = { input: request.input };
		if (request.model) payload.model = request.model;
		if (request.instructions) payload.instructions = request.instructions;

		const body = await this.#json("POST", "/v1/runs", {
			body: payload,
			headers: { "Idempotency-Key": idempotencyKey },
		});
		if (typeof body.run_id !== "string" || body.run_id === "") {
			throw new HermesError("bad_response", "Run start response without run_id");
		}
		return {
			runId: body.run_id,
			status: typeof body.status === "string" ? body.status : "started",
			replayed: body.replayed === true,
		};
	}

	/** `GET /v1/runs/{id}`. Throws `not_found` once Hermes has forgotten the run. */
	async getRun(runId: string): Promise<RunInfo> {
		const body = await this.#json("GET", `/v1/runs/${encodeURIComponent(runId)}`);
		return toRunInfo(runId, body);
	}

	/**
	 * `POST /v1/runs/{id}/stop`. Returns the status reported by the server — usually `stopping`;
	 * the run is only finished once a terminal status/event arrives.
	 */
	async stopRun(runId: string): Promise<string> {
		const body = await this.#json("POST", `/v1/runs/${encodeURIComponent(runId)}/stop`);
		if (typeof body.status !== "string") throw new HermesError("bad_response", "Stop response without status");
		return body.status;
	}

	/**
	 * `POST /v1/runs/{id}/approval`. With a request id only that exact request is answered.
	 * Throws `conflict` (code `approval_not_pending`) if nothing is pending anymore.
	 */
	async respondApproval(runId: string, choice: ApprovalChoice, requestId?: string): Promise<void> {
		const body: Record<string, string> = { choice };
		if (requestId) body.request_id = requestId;
		const res = await this.#json("POST", `/v1/runs/${encodeURIComponent(runId)}/approval`, { body });
		if (typeof res.resolved === "number" && res.resolved < 1) {
			throw new HermesError("conflict", "No approval resolved", 200, "approval_not_pending");
		}
	}

	/**
	 * `POST /v1/runs/{id}/steer`. Hermes queues the text and hands it to the agent at its next tool
	 * boundary, so success means "accepted", not "processed". Throws `conflict` with code
	 * `run_not_accepting_steer` unless the run is `running` (not while waiting for approval or
	 * stopping), or `steer_not_accepted`.
	 */
	async steerRun(runId: string, text: string): Promise<void> {
		const res = await this.#json("POST", `/v1/runs/${encodeURIComponent(runId)}/steer`, { body: { input: text } });
		if (res.accepted === false) throw new HermesError("conflict", "Steer not accepted", 200, "steer_not_accepted");
	}

	/**
	 * Follows `GET /v1/runs/{id}/events` until the server closes the stream, the signal aborts, or no
	 * data arrives for the idle timeout. Resolves normally when the server closes the stream; the
	 * caller must reconcile via {@link getRun} if no terminal event was seen.
	 */
	async streamEvents(runId: string, options: StreamOptions): Promise<void> {
		const controller = new AbortController();
		const abortFromCaller = () => controller.abort(options.signal?.reason);
		if (options.signal?.aborted) abortFromCaller();
		options.signal?.addEventListener("abort", abortFromCaller, { once: true });

		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		let idleExpired = false;
		const armIdle = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				idleExpired = true;
				controller.abort();
			}, this.#streamIdleTimeoutMs);
		};

		const headers: Record<string, string> = { Accept: "text/event-stream", ...this.#authHeaders() };
		if (options.lastEventId !== undefined) headers["Last-Event-ID"] = options.lastEventId;

		try {
			armIdle();
			let response: Response;
			try {
				response = await this.#fetch(this.#url(`/v1/runs/${encodeURIComponent(runId)}/events`), {
					method: "GET",
					headers,
					signal: controller.signal,
				});
			} catch (err) {
				if (idleExpired) throw new HermesError("timeout", "Event stream did not open in time");
				throw fromFetchError(err);
			}
			if (!response.ok) throw await errorFromResponse(response);
			if (!response.body) throw new HermesError("bad_response", "Event stream without body");

			const parser = new SseParser();
			const decoder = new TextDecoder();
			const reader = response.body.getReader();
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					armIdle();
					for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
						const event = toRunEvent(msg.id, msg.data);
						if (event) options.onEvent(event);
					}
				}
			} catch (err) {
				if (options.signal?.aborted) return;
				if (idleExpired) throw new HermesError("timeout", "Event stream went silent");
				throw fromFetchError(err);
			} finally {
				reader.releaseLock();
			}
		} catch (err) {
			if (options.signal?.aborted) return;
			throw err;
		} finally {
			clearTimeout(idleTimer);
			options.signal?.removeEventListener("abort", abortFromCaller);
		}
	}

	#authHeaders(): Record<string, string> {
		return { Authorization: `Bearer ${this.#apiKey}` };
	}

	#url(path: string): string {
		return `${this.baseUrl}${path}`;
	}

	async #json(
		method: "GET" | "POST",
		path: string,
		options: { auth?: boolean; body?: unknown; headers?: Record<string, string> } = {},
	): Promise<Record<string, unknown>> {
		if (this.baseUrl === "") throw new HermesError("not_configured", "Base URL missing");
		if (options.auth !== false && this.#apiKey === "") throw new HermesError("not_configured", "API key missing");

		const headers: Record<string, string> = { Accept: "application/json", ...options.headers };
		if (options.auth !== false) Object.assign(headers, this.#authHeaders());
		if (options.body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";

		let response: Response;
		try {
			response = await this.#fetch(this.#url(path), {
				method,
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: AbortSignal.timeout(this.#timeoutMs),
			});
		} catch (err) {
			throw fromFetchError(err);
		}
		if (!response.ok) throw await errorFromResponse(response);

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new HermesError("bad_response", `Non-JSON response from ${path}`, response.status);
		}
		if (!isRecord(body)) throw new HermesError("bad_response", `Unexpected response shape from ${path}`, response.status);
		return body;
	}
}

export function normalizeBaseUrl(value: string): string {
	let url = value.trim();
	if (url === "") return "";
	if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
	return url.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

async function errorFromResponse(response: Response): Promise<HermesError> {
	let code: string | undefined;
	let message = `HTTP ${response.status}`;
	try {
		const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
		if (typeof body?.error?.code === "string") code = body.error.code;
		// Server messages are short and do not echo secrets; truncate defensively.
		if (typeof body?.error?.message === "string") message = `HTTP ${response.status}: ${body.error.message.slice(0, 200)}`;
	} catch {
		// Body was not JSON (e.g. plain "404: Not Found").
	}

	const status = response.status;
	if (status === 401 || status === 403) return new HermesError("auth", message, status, code);
	if (status === 404) return new HermesError("not_found", message, status, code);
	if (status === 409) return new HermesError("conflict", message, status, code);
	if (status === 429) return new HermesError("rate_limited", message, status, code);
	if (status >= 500) return new HermesError("server", message, status, code);
	return new HermesError("bad_request", message, status, code);
}

function toRunInfo(runId: string, body: Record<string, unknown>): RunInfo {
	if (typeof body.status !== "string") throw new HermesError("bad_response", "Run status response without status");
	const info: RunInfo = {
		runId: typeof body.run_id === "string" ? body.run_id : runId,
		status: body.status,
	};
	if (typeof body.last_event === "string") info.lastEvent = body.last_event;
	if (typeof body.turn_exit_reason === "string") info.turnExitReason = body.turn_exit_reason;
	if (typeof body.error === "string") info.error = body.error;
	else if (isRecord(body.error) && typeof body.error.message === "string") info.error = body.error.message;
	if (isRecord(body.approval)) info.approval = parseApproval(body.approval);
	if (typeof body.output === "string") info.output = body.output;
	if (typeof body.pending_steer === "string" && body.pending_steer) info.pendingSteer = body.pending_steer;
	return info;
}

/**
 * Reads an approval request (SSE `approval.request` payload or the status' `approval` field).
 */
export function parseApproval(data: Record<string, unknown>): PendingApproval | undefined {
	if (typeof data.command !== "string" && typeof data.description !== "string") return undefined;
	const offered = Array.isArray(data.choices) ? data.choices.filter((c): c is ApprovalChoice => APPROVAL_CHOICES.includes(c as ApprovalChoice)) : [];
	const approval: PendingApproval = {
		command: typeof data.command === "string" ? data.command : "",
		description: typeof data.description === "string" ? data.description : "",
		// Without a list, fall back to the two answers every request accepts.
		choices: offered.length > 0 ? offered : ["once", "deny"],
	};
	if (typeof data.request_id === "string" && data.request_id) approval.requestId = data.request_id;
	if (typeof data.timestamp === "number") approval.requestedAt = Math.round(data.timestamp * 1000);
	return approval;
}

function toRunEvent(id: string | undefined, data: string): RunEvent | undefined {
	let payload: unknown;
	try {
		payload = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (!isRecord(payload) || typeof payload.event !== "string") return undefined;
	return {
		id,
		event: payload.event,
		runId: typeof payload.run_id === "string" ? payload.run_id : undefined,
		payload,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
