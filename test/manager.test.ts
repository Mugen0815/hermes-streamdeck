import { afterEach, describe, expect, it } from "vitest";

import type { HermesClient, StreamOptions } from "../src/hermes/client";
import { HermesError } from "../src/hermes/errors";
import type { RunEvent, RunInfo, StartRunRequest, StartRunResult } from "../src/hermes/types";
import { RunManager, type PersistedRun } from "../src/runs/manager";
import type { RunSnapshot } from "../src/runs/state";

/**
 * Scriptable stand-in for {@link HermesClient}. Streams stay open until the test pushes events or
 * closes them, like the real server.
 */
class FakeHermes {
	configured = true;
	status = new Map<string, string>();
	startCalls: { request: StartRunRequest; key: string }[] = [];
	startBehaviour: (call: number) => StartRunResult | Error = () => ({ runId: "run_1", status: "started", replayed: false });
	stopCalls: string[] = [];
	approvalCalls: { runId: string; choice: string; requestId?: string }[] = [];
	approvalError: Error | undefined;
	getRunError: Error | undefined;
	streamError: Error | undefined;
	streams: { runId: string; lastEventId?: string; push: (e: RunEvent) => void; close: () => void }[] = [];

	async startRun(request: StartRunRequest, key: string): Promise<StartRunResult> {
		this.startCalls.push({ request, key });
		await tick();
		const result = this.startBehaviour(this.startCalls.length);
		if (result instanceof Error) throw result;
		this.status.set(result.runId, "running");
		return result;
	}

	async getRun(runId: string): Promise<RunInfo> {
		await tick();
		if (this.getRunError) throw this.getRunError;
		const status = this.status.get(runId);
		if (!status) throw new HermesError("not_found", "Run not found", 404, "run_not_found");
		return { runId, status };
	}

	async stopRun(runId: string): Promise<string> {
		this.stopCalls.push(runId);
		await tick();
		if (!this.status.has(runId)) throw new HermesError("not_found", "Run not found", 404);
		this.status.set(runId, "stopping");
		return "stopping";
	}

	async respondApproval(runId: string, choice: string, requestId?: string): Promise<void> {
		this.approvalCalls.push({ runId, choice, requestId });
		await tick();
		if (this.approvalError) throw this.approvalError;
		this.status.set(runId, "running");
	}

	streamEvents(runId: string, options: StreamOptions): Promise<void> {
		if (this.streamError) return Promise.reject(this.streamError);
		return new Promise((resolve) => {
			const close = () => resolve();
			options.signal?.addEventListener("abort", close, { once: true });
			this.streams.push({ runId, lastEventId: options.lastEventId, push: options.onEvent, close });
		});
	}

	openStream(runId: string) {
		return [...this.streams].reverse().find((s) => s.runId === runId);
	}
}

const tick = () => new Promise((r) => setTimeout(r, 1));

async function waitFor(check: () => boolean, ms = 1_000): Promise<void> {
	const until = Date.now() + ms;
	while (!check()) {
		if (Date.now() > until) throw new Error("waitFor timed out");
		await tick();
	}
}

function event(name: string, id: string): RunEvent {
	return { id, event: name, runId: "run_1", payload: { event: name } };
}

let managers: RunManager[] = [];
afterEach(() => {
	for (const m of managers) m.dispose();
	managers = [];
});

function setup() {
	const hermes = new FakeHermes();
	const persisted = new Map<string, PersistedRun | undefined>();
	const history: RunSnapshot[] = [];
	const manager = new RunManager({
		client: () => hermes as unknown as HermesClient,
		persist: (key, run) => persisted.set(key, run),
		onChange: (_key, snapshot) => history.push(snapshot),
		tracker: { pollIntervalMs: 5, backoffMs: [5], reopenDelayMs: 5 },
		startRetryDelayMs: 5,
	});
	managers.push(manager);
	const phase = (key = "k1") => manager.snapshot(key).phase;
	return { hermes, manager, persisted, history, phase };
}

describe("RunManager", () => {
	it("starts one run, follows SSE and ends in completed", async () => {
		const { hermes, manager, persisted, history, phase } = setup();
		expect(await manager.start("k1", { input: "hello" })).toBe("started");
		expect(phase()).toBe("running");
		expect(manager.snapshot("k1").runId).toBe("run_1");
		expect(persisted.get("k1")).toMatchObject({ runId: "run_1", phase: "running" });

		await waitFor(() => !!hermes.openStream("run_1"));
		hermes.openStream("run_1")!.push(event("message.delta", "0"));
		hermes.openStream("run_1")!.push(event("run.completed", "1"));
		await waitFor(() => phase() === "completed");

		expect(history.map((s) => s.phase)).toContain("starting");
		expect(persisted.get("k1")).toMatchObject({ runId: "run_1", phase: "completed" });
		expect(manager.lastStartedKey).toBe("k1");
	});

	it("refuses rapid repeated presses: exactly one POST", async () => {
		const { hermes, manager } = setup();
		const results = await Promise.all([
			manager.start("k1", { input: "x" }),
			manager.start("k1", { input: "x" }),
			manager.start("k1", { input: "x" }),
		]);
		expect(results).toEqual(["started", "busy", "busy"]);
		expect(hermes.startCalls).toHaveLength(1);
		// Still busy while the run is active.
		expect(await manager.start("k1", { input: "x" })).toBe("busy");
		expect(hermes.startCalls).toHaveLength(1);
	});

	it("allows a new run after the previous one ended", async () => {
		const { hermes, manager, phase } = setup();
		await manager.start("k1", { input: "x" });
		await waitFor(() => !!hermes.openStream("run_1"));
		hermes.openStream("run_1")!.push(event("run.failed", "0"));
		await waitFor(() => phase() === "failed");

		hermes.startBehaviour = () => ({ runId: "run_2", status: "started", replayed: false });
		expect(await manager.start("k1", { input: "x" })).toBe("started");
		expect(manager.snapshot("k1").runId).toBe("run_2");
	});

	it("retries a start once with the same idempotency key after a transient error", async () => {
		const { hermes, manager, phase } = setup();
		hermes.startBehaviour = (n) => (n === 1 ? new HermesError("timeout", "timed out") : { runId: "run_1", status: "running", replayed: true });
		expect(await manager.start("k1", { input: "x" })).toBe("started");
		expect(hermes.startCalls).toHaveLength(2);
		expect(hermes.startCalls[0]!.key).toBe(hermes.startCalls[1]!.key);
		expect(phase()).toBe("running");
	});

	it("shows start_failed when the response has no usable run id", async () => {
		const { hermes, manager, persisted, phase } = setup();
		hermes.startBehaviour = () => new HermesError("bad_response", "no run_id");
		expect(await manager.start("k1", { input: "x" })).toBe("failed");
		expect(phase()).toBe("start_failed");
		expect(manager.snapshot("k1").detail).toBe("Invalid response");
		expect(persisted.get("k1")).toBeUndefined();
		expect(hermes.startCalls).toHaveLength(1); // not transient: no retry
	});

	it("does not call Hermes without configuration or prompt", async () => {
		const { hermes, manager } = setup();
		expect(await manager.start("k1", { input: "   " })).toBe("failed");
		expect(manager.snapshot("k1").detail).toBe("No prompt");
		hermes.configured = false;
		expect(await manager.start("k2", { input: "x" })).toBe("failed");
		expect(manager.snapshot("k2").detail).toBe("Not configured");
		expect(hermes.startCalls).toHaveLength(0);
	});

	it("reconciles via GET when SSE drops without a terminal event", async () => {
		const { hermes, manager, phase } = setup();
		await manager.start("k1", { input: "x" });
		await waitFor(() => !!hermes.openStream("run_1"));
		hermes.openStream("run_1")!.push(event("tool.started", "0"));

		// Run finishes while the stream is gone.
		hermes.status.set("run_1", "completed");
		hermes.openStream("run_1")!.close();
		await waitFor(() => phase() === "completed");
	});

	it("resumes the stream with Last-Event-ID", async () => {
		const { hermes, manager } = setup();
		await manager.start("k1", { input: "x" });
		await waitFor(() => !!hermes.openStream("run_1"));
		hermes.openStream("run_1")!.push(event("tool.started", "3"));
		const first = hermes.openStream("run_1")!;
		first.close();
		await waitFor(() => hermes.openStream("run_1") !== first);
		expect(hermes.openStream("run_1")!.lastEventId).toBe("3");
	});

	it("falls back to polling when the event stream is gone (404)", async () => {
		const { hermes, manager, phase } = setup();
		hermes.streamError = new HermesError("not_found", "404");
		await manager.start("k1", { input: "x" });
		await tick();
		hermes.status.set("run_1", "waiting_for_approval");
		await waitFor(() => phase() === "approval");
		hermes.status.set("run_1", "cancelled");
		await waitFor(() => phase() === "cancelled");
	});

	it("flags lost connectivity without inventing a result, then recovers", async () => {
		const { hermes, manager, phase } = setup();
		await manager.start("k1", { input: "x" });
		await waitFor(() => !!hermes.openStream("run_1"));

		hermes.getRunError = new HermesError("unreachable", "tunnel down");
		hermes.streamError = new HermesError("unreachable", "tunnel down");
		hermes.openStream("run_1")!.close();
		await waitFor(() => manager.snapshot("k1").reconnecting === true);
		expect(phase()).toBe("running");
		expect(manager.snapshot("k1").detail).toBe("Hermes unreachable");

		hermes.status.set("run_1", "completed");
		hermes.getRunError = undefined;
		await waitFor(() => phase() === "completed");
		expect(manager.snapshot("k1").reconnecting).toBe(false);
	});

	describe("approvals", () => {
		const request = (id: string, choices: string[] = ["once", "session", "always", "deny"]): RunEvent => ({
			id: "1",
			event: "approval.request",
			runId: "run_1",
			payload: {
				event: "approval.request",
				command: "rm -r /tmp/x",
				description: "delete in root path",
				request_id: id,
				choices,
				timestamp: 1790625795.37,
			},
		});

		async function waitingRun() {
			const ctx = setup();
			await ctx.manager.start("k1", { input: "x" });
			await waitFor(() => !!ctx.hermes.openStream("run_1"));
			ctx.hermes.status.set("run_1", "waiting_for_approval");
			ctx.hermes.openStream("run_1")!.push(request("req-1"));
			await waitFor(() => ctx.phase() === "approval");
			return { ...ctx, request };
		}

		it("exposes the pending request on the snapshot", async () => {
			const { manager } = await waitingRun();
			expect(manager.snapshot("k1").approval).toEqual({
				command: "rm -r /tmp/x",
				description: "delete in root path",
				requestId: "req-1",
				choices: ["once", "session", "always", "deny"],
				requestedAt: 1790625795370,
			});
		});

		it("answers exactly the pending request id", async () => {
			const { hermes, manager, phase } = await waitingRun();
			expect(await manager.respondApproval("k1", "req-other", "once")).toBe("not_pending");
			expect(hermes.approvalCalls).toHaveLength(0);

			expect(await manager.respondApproval("k1", "req-1", "session")).toBe("answered");
			expect(hermes.approvalCalls).toEqual([{ runId: "run_1", choice: "session", requestId: "req-1" }]);
			expect(phase()).toBe("running");
			expect(manager.snapshot("k1").approval).toBeUndefined();
			expect(await manager.respondApproval("k1", "req-1", "once")).toBe("not_pending");
		});

		it("refuses choices Hermes did not offer", async () => {
			const { hermes, manager } = await waitingRun();
			hermes.openStream("run_1")!.push(request("req-2", ["once", "deny"]));
			await waitFor(() => manager.snapshot("k1").approval?.requestId === "req-2");
			expect(await manager.respondApproval("k1", "req-2", "always")).toBe("not_allowed");
			expect(hermes.approvalCalls).toHaveLength(0);
		});

		it("marks a completed run whose approval was denied", async () => {
			const { hermes, manager, persisted, phase } = await waitingRun();
			expect(await manager.respondApproval("k1", "req-1", "deny")).toBe("answered");
			await waitFor(() => !!hermes.openStream("run_1"));
			hermes.status.set("run_1", "completed");
			hermes.openStream("run_1")!.push(event("run.completed", "5"));
			await waitFor(() => phase() === "completed");
			expect(manager.snapshot("k1").denied).toBe(true);
			expect(persisted.get("k1")).toMatchObject({ phase: "completed", denied: true });
		});

		it("clears the approval when it was answered elsewhere", async () => {
			const { hermes, manager, phase } = await waitingRun();
			hermes.openStream("run_1")!.push({
				id: "2",
				event: "approval.responded",
				runId: "run_1",
				payload: { event: "approval.responded", choice: "once", request_id: "req-1" },
			});
			await waitFor(() => phase() === "running");
			expect(manager.snapshot("k1").approval).toBeUndefined();
			expect(manager.snapshot("k1").denied).toBeUndefined();
		});

		it("reports not_pending when Hermes says nothing is pending anymore", async () => {
			const { hermes, manager } = await waitingRun();
			hermes.approvalError = new HermesError("conflict", "409", 409, "approval_not_pending");
			expect(await manager.respondApproval("k1", "req-1", "once")).toBe("not_pending");
		});

		it("picks up a pending approval from the status after a restart", async () => {
			const { hermes, manager, phase } = setup();
			hermes.getRun = async (runId: string) => ({
				runId,
				status: "waiting_for_approval",
				approval: { command: "rm -r /tmp/x", description: "delete in root path", requestId: "req-9", choices: ["once", "deny"] },
			});
			manager.restore("k1", { runId: "run_1", phase: "running" });
			await waitFor(() => phase() === "approval");
			expect(manager.snapshot("k1").approval?.requestId).toBe("req-9");
		});
	});

	describe("results", () => {
		it("reports a finished run once, with output and the resolved request", async () => {
			const finished: { key: string; snapshot: RunSnapshot; input?: string }[] = [];
			const hermes = new FakeHermes();
			const manager = new RunManager({
				client: () => hermes as unknown as HermesClient,
				persist: () => {},
				onChange: () => {},
				onFinished: (key, snapshot, request) => finished.push({ key, snapshot, input: request?.input }),
				tracker: { pollIntervalMs: 5, backoffMs: [5], reopenDelayMs: 5 },
			});
			managers.push(manager);
			await manager.start("k1", { input: "prompt X" });
			await waitFor(() => !!hermes.openStream("run_1"));
			hermes.openStream("run_1")!.push({ id: "3", event: "run.completed", runId: "run_1", payload: { event: "run.completed", output: "answer Y" } });
			await waitFor(() => finished.length === 1);
			await tick();
			expect(finished).toHaveLength(1);
			expect(finished[0]).toMatchObject({ key: "k1", input: "prompt X", snapshot: { phase: "completed", output: "answer Y" } });
		});

		it("takes the output from the status when the stream missed the terminal event", async () => {
			const { hermes, manager, phase } = setup();
			await manager.start("k1", { input: "x" });
			await waitFor(() => !!hermes.openStream("run_1"));
			hermes.getRun = async (runId: string) => ({ runId, status: "completed", output: "from the status" });
			hermes.openStream("run_1")!.close();
			await waitFor(() => phase() === "completed");
			expect(manager.snapshot("k1").output).toBe("from the status");
		});

		it("persists the result file and restores it", async () => {
			const { hermes, manager, persisted, phase } = setup();
			await manager.start("k1", { input: "x" });
			await waitFor(() => !!hermes.openStream("run_1"));
			hermes.openStream("run_1")!.push(event("run.completed", "1"));
			await waitFor(() => phase() === "completed");
			manager.attachResult("k1", "run_1", "C:\\r.md");
			expect(persisted.get("k1")).toMatchObject({ runId: "run_1", phase: "completed", resultFile: "C:\\r.md" });

			const other = setup();
			other.manager.restore("k1", persisted.get("k1"));
			expect(other.manager.snapshot("k1").resultFile).toBe("C:\\r.md");
		});

		it("marks a key failed before any request (e.g. empty clipboard)", async () => {
			const { hermes, manager, phase } = setup();
			manager.failBeforeStart("k1", "Clipboard empty");
			expect(phase()).toBe("start_failed");
			expect(manager.snapshot("k1").detail).toBe("Clipboard empty");
			expect(hermes.startCalls).toHaveLength(0);
		});
	});

	describe("acknowledging a finished run", () => {
		it("reset clears a terminal run and its persisted state", async () => {
			const { hermes, manager, persisted, phase } = setup();
			await manager.start("k1", { input: "x" });
			await waitFor(() => !!hermes.openStream("run_1"));
			hermes.openStream("run_1")!.push(event("run.completed", "0"));
			await waitFor(() => phase() === "completed");

			manager.reset("k1");
			expect(phase()).toBe("idle");
			expect(manager.snapshot("k1").runId).toBeUndefined();
			expect(persisted.get("k1")).toBeUndefined();
		});

		it("reset clears a failed start", async () => {
			const { hermes, manager, phase } = setup();
			hermes.startBehaviour = () => new HermesError("auth", "401");
			await manager.start("k1", { input: "x" });
			expect(phase()).toBe("start_failed");
			manager.reset("k1");
			expect(phase()).toBe("idle");
		});

		it("reset leaves an active run untouched", async () => {
			const { manager, phase } = setup();
			await manager.start("k1", { input: "x" });
			manager.reset("k1");
			expect(phase()).toBe("running");
		});
	});

	describe("restore after restart", () => {
		it("re-checks an active run and marks it lost when the server forgot it", async () => {
			const { manager, persisted, phase } = setup();
			manager.restore("k1", { runId: "run_gone", phase: "running", startedAt: 1 });
			expect(phase()).toBe("checking");
			await waitFor(() => phase() === "lost");
			expect(manager.snapshot("k1").detail).toBe("run unknown");
			expect(persisted.get("k1")).toMatchObject({ runId: "run_gone", phase: "lost" });
		});

		it("picks up a run that is still running", async () => {
			const { hermes, manager, phase } = setup();
			hermes.status.set("run_1", "running");
			manager.restore("k1", { runId: "run_1", phase: "running" });
			await waitFor(() => phase() === "running");
			await waitFor(() => !!hermes.openStream("run_1"));
			hermes.openStream("run_1")!.push(event("run.completed", "5"));
			await waitFor(() => phase() === "completed");
		});

		it("shows a persisted terminal state without asking the server", async () => {
			const { manager, phase } = setup();
			manager.restore("k1", { runId: "run_old", phase: "completed" });
			expect(phase()).toBe("completed");
		});

		it("does not overwrite a run tracked in this session", async () => {
			const { manager, phase } = setup();
			await manager.start("k1", { input: "x" });
			manager.restore("k1", { runId: "run_other", phase: "completed" });
			expect(phase()).toBe("running");
		});
	});

	describe("stop", () => {
		it("reports no_run without an active run", async () => {
			const { hermes, manager } = setup();
			expect(await manager.stop("k1")).toBe("no_run");
			expect(hermes.stopCalls).toHaveLength(0);
		});

		it("shows stopping until Hermes confirms cancelled", async () => {
			const { hermes, manager, phase } = setup();
			await manager.start("k1", { input: "x" });
			await waitFor(() => !!hermes.openStream("run_1"));

			expect(await manager.stop("k1")).toBe("requested");
			expect(hermes.stopCalls).toEqual(["run_1"]);
			expect(phase()).toBe("stopping");

			// The HTTP call succeeded, but the run is not over yet.
			await tick();
			await tick();
			expect(phase()).toBe("stopping");
			expect(await manager.stop("k1")).toBe("already_stopping");

			await waitFor(() => !!hermes.openStream("run_1"));
			hermes.status.set("run_1", "cancelled");
			hermes.openStream("run_1")!.push(event("run.cancelled", "9"));
			await waitFor(() => phase() === "cancelled");
			expect(await manager.stop("k1")).toBe("no_run");
		});

		it("reverts to the previous phase when the stop request fails", async () => {
			const { hermes, manager, phase } = setup();
			await manager.start("k1", { input: "x" });
			await waitFor(() => !!hermes.openStream("run_1"));
			hermes.stopRun = async () => {
				throw new HermesError("unreachable", "down");
			};
			expect(await manager.stop("k1")).toBe("failed");
			expect(phase()).toBe("running");
		});
	});
});
