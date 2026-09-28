import { describe, expect, it } from "vitest";

import { applyEvent, isActivePhase, isTerminalPhase, mergeStatus, phaseFromStatus, type RunPhase } from "../src/runs/state";

const ev = (event: string) => ({ event, payload: { event } });

describe("run state", () => {
	it("maps every documented server status", () => {
		expect(phaseFromStatus("started")).toBe("running");
		expect(phaseFromStatus("running")).toBe("running");
		expect(phaseFromStatus("waiting_for_approval")).toBe("approval");
		expect(phaseFromStatus("stopping")).toBe("stopping");
		expect(phaseFromStatus("completed")).toBe("completed");
		expect(phaseFromStatus("failed")).toBe("failed");
		expect(phaseFromStatus("cancelled")).toBe("cancelled");
		expect(phaseFromStatus("interrupted")).toBe("interrupted");
	});

	it("never treats an unknown status as success", () => {
		expect(phaseFromStatus("something_new")).toBe("running");
	});

	it("separates terminal from active phases", () => {
		const terminal: RunPhase[] = ["completed", "cancelled", "failed", "interrupted", "lost", "start_failed"];
		const active: RunPhase[] = ["checking", "starting", "running", "approval", "stopping"];
		for (const p of terminal) expect([isTerminalPhase(p), isActivePhase(p)]).toEqual([true, false]);
		for (const p of active) expect([isTerminalPhase(p), isActivePhase(p)]).toEqual([false, true]);
		expect([isTerminalPhase("idle"), isActivePhase("idle")]).toEqual([false, false]);
	});

	it("follows a run through approval to completion", () => {
		let p: RunPhase = "running";
		p = applyEvent(p, ev("tool.started"));
		expect(p).toBe("running");
		p = applyEvent(p, ev("approval.request"));
		expect(p).toBe("approval");
		p = applyEvent(p, ev("tool.completed"));
		expect(p).toBe("running");
		p = applyEvent(p, ev("run.completed"));
		expect(p).toBe("completed");
	});

	it("keeps terminal phases sticky", () => {
		expect(applyEvent("completed", ev("message.delta"))).toBe("completed");
		expect(applyEvent("cancelled", ev("run.completed"))).toBe("cancelled");
	});

	it("keeps a requested stop visible until the terminal event", () => {
		expect(applyEvent("stopping", ev("tool.completed"))).toBe("stopping");
		expect(applyEvent("stopping", ev("approval.request"))).toBe("stopping");
		expect(applyEvent("stopping", ev("run.cancelled"))).toBe("cancelled");
		expect(mergeStatus("stopping", "running")).toBe("stopping");
		expect(mergeStatus("stopping", "cancelled")).toBe("cancelled");
		expect(mergeStatus("running", "waiting_for_approval")).toBe("approval");
	});

	it("maps all terminal events", () => {
		expect(applyEvent("running", ev("run.failed"))).toBe("failed");
		expect(applyEvent("running", ev("run.cancelled"))).toBe("cancelled");
		expect(applyEvent("running", ev("run.interrupted"))).toBe("interrupted");
	});
});
