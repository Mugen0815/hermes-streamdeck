import { describe, expect, it } from "vitest";

import { portMismatch, runConnectionTest } from "../src/connection-test";
import type { HermesClient } from "../src/hermes/client";
import { HermesError } from "../src/hermes/errors";
import type { TunnelConfig, TunnelController, TunnelStatus } from "../src/tunnel/tunnel";

const CONFIG: TunnelConfig = { sshHost: "hermes-tunnel", localPort: 8642, remoteHost: "127.0.0.1", remotePort: 8642 };

function fakeClient(opts: { health?: Error; caps?: Error; configured?: boolean; features?: Record<string, unknown> } = {}) {
	return {
		baseUrl: "http://127.0.0.1:8642",
		configured: opts.configured ?? true,
		health: async () => {
			if (opts.health) throw opts.health;
			return { status: "ok", version: "0.21.5" };
		},
		capabilities: async () => {
			if (opts.caps) throw opts.caps;
			return { features: opts.features ?? { run_submission: true, run_status: true, run_events_sse: true, run_stop: true } };
		},
	} as unknown as HermesClient;
}

function fakeTunnel(opts: { config?: TunnelConfig; owned?: boolean; startOutcome?: string; afterStart?: TunnelStatus }) {
	const calls = { start: 0, stop: 0 };
	let status: TunnelStatus = { state: "off" };
	const tunnel = {
		config: opts.config,
		get owned() {
			return opts.owned ?? false;
		},
		get status() {
			return status;
		},
		start: async () => {
			calls.start++;
			status = opts.afterStart ?? { state: "connected" };
			return opts.startOutcome ?? "started";
		},
		stop: async () => {
			calls.stop++;
			status = { state: "off" };
		},
	} as unknown as TunnelController;
	return { tunnel, calls };
}

const texts = (r: { steps: { status: string; text: string }[] }) => r.steps.map((s) => `${s.status}: ${s.text}`);

describe("runConnectionTest", () => {
	it("opens a temporary tunnel, checks Hermes and key, then closes the tunnel", async () => {
		const { tunnel, calls } = fakeTunnel({ config: CONFIG });
		const report = await runConnectionTest(fakeClient(), tunnel);
		expect(report.ok).toBe(true);
		expect(texts(report)).toEqual([
			"ok: SSH tunnel to hermes-tunnel opened (for this test only).",
			"ok: Hermes 0.21.5 reachable at http://127.0.0.1:8642.",
			"ok: API key valid.",
			"info: Test tunnel closed again.",
		]);
		expect(calls).toEqual({ start: 1, stop: 1 });
	});

	it("uses a running tunnel and leaves it open", async () => {
		const { tunnel, calls } = fakeTunnel({ config: CONFIG, owned: true });
		const report = await runConnectionTest(fakeClient(), tunnel);
		expect(report.ok).toBe(true);
		expect(report.steps[0]!.text).toBe("Tunnel to hermes-tunnel is running.");
		expect(calls).toEqual({ start: 0, stop: 0 });
	});

	it("uses an external tunnel without closing it", async () => {
		const { tunnel, calls } = fakeTunnel({ config: CONFIG, startOutcome: "external", afterStart: { state: "external" } });
		const report = await runConnectionTest(fakeClient(), tunnel);
		expect(report.ok).toBe(true);
		expect(report.steps[0]!.status).toBe("info");
		expect(calls.stop).toBe(0);
	});

	it("stops at a failed SSH connection with the reason and does not blame Hermes", async () => {
		const { tunnel, calls } = fakeTunnel({ config: CONFIG, afterStart: { state: "error", detail: "Access denied" } });
		const report = await runConnectionTest(fakeClient(), tunnel);
		expect(report.ok).toBe(false);
		expect(texts(report)).toEqual([
			"error: SSH to hermes-tunnel: Access denied.",
			"info: Hermes not checked because the tunnel is missing.",
		]);
		expect(calls.stop).toBe(0);
	});

	it("names Hermes as the problem when the tunnel works but Hermes does not answer", async () => {
		const { tunnel, calls } = fakeTunnel({ config: CONFIG, afterStart: { state: "no_hermes" } });
		const report = await runConnectionTest(fakeClient({ health: new HermesError("unreachable", "x") }), tunnel);
		expect(report.ok).toBe(false);
		expect(report.steps[1]!.text).toContain("Hermes unreachable");
		expect(report.steps[1]!.text).toContain("is the Hermes API server running");
		expect(report.steps.at(-1)!.text).toBe("Test tunnel closed again.");
		expect(calls.stop).toBe(1);
	});

	it("reports an invalid API key after a working connection", async () => {
		const { tunnel } = fakeTunnel({ config: CONFIG, owned: true });
		const report = await runConnectionTest(fakeClient({ caps: new HermesError("auth", "401") }), tunnel);
		expect(report.ok).toBe(false);
		expect(report.steps.at(-1)!).toEqual({ status: "error", text: "Invalid API key (Hermes rejects it)." });
	});

	it("reports a missing API key", async () => {
		const { tunnel } = fakeTunnel({ config: CONFIG, owned: true });
		const report = await runConnectionTest(fakeClient({ configured: false }), tunnel);
		expect(report.steps.at(-1)!.text).toContain("No API key");
	});

	it("checks the URL directly when no tunnel is configured", async () => {
		const { tunnel, calls } = fakeTunnel({ config: { ...CONFIG, sshHost: "" } });
		const report = await runConnectionTest(fakeClient(), tunnel);
		expect(report.ok).toBe(true);
		expect(report.steps[0]!.text).toContain("No tunnel set up");
		expect(calls.start).toBe(0);
	});

	it("warns about missing run features", async () => {
		const { tunnel } = fakeTunnel({ config: CONFIG, owned: true });
		const report = await runConnectionTest(fakeClient({ features: { run_submission: true } }), tunnel);
		expect(report.ok).toBe(true);
		expect(report.steps.at(-1)!.status).toBe("warn");
	});
});

describe("portMismatch", () => {
	it("flags a different local port or a non-local URL", () => {
		expect(portMismatch("http://127.0.0.1:8642", 8642)).toBeUndefined();
		expect(portMismatch("http://localhost:8642", 8642)).toBeUndefined();
		expect(portMismatch("http://127.0.0.1:9000", 8642)).toBe("Hermes URL uses port 9000, the tunnel port 8642.");
		expect(portMismatch("http://hermes.example:8642", 8642)).toContain("not to the tunnel");
	});
});
