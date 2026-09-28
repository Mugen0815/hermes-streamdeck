import type { PendingApproval, RunEvent } from "../hermes/types";

/**
 * What a Start Run key shows for its run.
 */
export type RunPhase =
	| "idle" // no run yet (or reset) — "Ready"
	| "checking" // restored after a restart, waiting for the first status reconcile
	| "starting" // POST /v1/runs in flight
	| "running"
	| "approval" // waiting_for_approval
	| "stopping" // stop requested, terminal state not yet confirmed
	| "completed"
	| "cancelled"
	| "failed"
	| "interrupted" // Hermes gateway shut down mid-run
	| "lost" // run id no longer known to the server — outcome unknown
	| "start_failed"; // run could not be started

export type RunSnapshot = {
	phase: RunPhase;
	runId?: string;
	startedAt?: number;
	endedAt?: number;
	/** Short user-facing detail, e.g. an error category. */
	detail?: string;
	/** True while the tracker cannot reach Hermes and the phase may be stale. */
	reconnecting?: boolean;
	/** Approval Hermes is waiting for (phase `approval`). */
	approval?: PendingApproval;
	/** An approval of this run was denied; a "completed" run then did not do everything asked. */
	denied?: boolean;
	/** Final answer / error text (in memory only, not persisted). */
	output?: string;
	error?: string;
	/** Markdown file with the result, once written. */
	resultFile?: string;
};

const TERMINAL: ReadonlySet<RunPhase> = new Set(["completed", "cancelled", "failed", "interrupted", "lost", "start_failed"]);
const ACTIVE: ReadonlySet<RunPhase> = new Set(["checking", "starting", "running", "approval", "stopping"]);

export function isTerminalPhase(phase: RunPhase): boolean {
	return TERMINAL.has(phase);
}

/** A run the plugin still considers in progress (blocks a new start, can be stopped). */
export function isActivePhase(phase: RunPhase): boolean {
	return ACTIVE.has(phase);
}

/**
 * Maps a server run status to a phase. Unknown statuses are treated as still running — never as success.
 */
export function phaseFromStatus(status: string): RunPhase {
	switch (status) {
		case "started":
		case "running":
			return "running";
		case "waiting_for_approval":
			return "approval";
		case "stopping":
			return "stopping";
		case "completed":
			return "completed";
		case "cancelled":
			return "cancelled";
		case "failed":
			return "failed";
		case "interrupted":
			return "interrupted";
		default:
			return "running";
	}
}

/**
 * Applies one lifecycle event to the current phase. Returns the new phase (possibly unchanged).
 */
export function applyEvent(current: RunPhase, event: RunEvent): RunPhase {
	if (isTerminalPhase(current)) return current;

	switch (event.event) {
		case "run.completed":
			return "completed";
		case "run.failed":
			return "failed";
		case "run.cancelled":
			return "cancelled";
		case "run.interrupted":
			return "interrupted";
		case "approval.request":
			return current === "stopping" ? "stopping" : "approval";
	}

	// Any other activity means the agent is working again (e.g. after an approval was answered).
	// A requested stop stays visible until the terminal event arrives.
	if (current === "stopping") return "stopping";
	return "running";
}

/**
 * Combines a reconciled server status with the locally known phase. A locally requested stop is
 * not overwritten by a stale `running` status.
 */
export function mergeStatus(current: RunPhase, serverStatus: string): RunPhase {
	const next = phaseFromStatus(serverStatus);
	if (current === "stopping" && (next === "running" || next === "approval")) return "stopping";
	return next;
}
