/**
 * Run status values as returned by `GET /v1/runs/{id}` (verified against Hermes 0.21.5).
 * `started` is only returned by `POST /v1/runs`.
 */
export type RunStatus =
	| "started"
	| "running"
	| "waiting_for_approval"
	| "stopping"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);

export type RunInfo = {
	runId: string;
	/** Raw status string; unknown values are passed through so callers can treat them conservatively. */
	status: string;
	lastEvent?: string;
	/** Short error text from the server, if any. Not shown verbatim on keys. */
	error?: string;
	turnExitReason?: string;
	/** Pending approval while status is `waiting_for_approval`. */
	approval?: PendingApproval;
	/** Final answer text of a finished run. */
	output?: string;
};

/**
 * Answers accepted by `POST /v1/runs/{id}/approval` (field `choice`; verified against 0.21.5 — the
 * docs' `decision` field is rejected).
 */
export type ApprovalChoice = "once" | "session" | "always" | "deny";

export const APPROVAL_CHOICES: readonly ApprovalChoice[] = ["once", "session", "always", "deny"];

/**
 * An approval Hermes is waiting for, from `approval.request` or the `approval` field of the run status.
 * `command` is already redacted by Hermes before it leaves the server.
 */
export type PendingApproval = {
	requestId?: string;
	command: string;
	description: string;
	/** Choices Hermes offers for this request (e.g. no session/always after a smart-deny). */
	choices: ApprovalChoice[];
	/** Server timestamp (ms) when the request was raised, if known. */
	requestedAt?: number;
};

export type StartRunRequest = {
	input: string;
	model?: string;
	instructions?: string;
};

export type StartRunResult = {
	runId: string;
	status: string;
	replayed: boolean;
};

/**
 * One lifecycle event from `GET /v1/runs/{id}/events`. Hermes puts the event name into the JSON
 * payload (`event` field); there is no SSE `event:` line.
 */
export type RunEvent = {
	/** SSE id (the server's `seq`), used for `Last-Event-ID` on reconnect. */
	id?: string;
	event: string;
	runId?: string;
	payload: Record<string, unknown>;
};

export type HealthInfo = {
	status: string;
	version?: string;
	platform?: string;
};

export type Capabilities = {
	authType?: string;
	features: Record<string, unknown>;
};
