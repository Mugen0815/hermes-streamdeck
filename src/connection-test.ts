import type { HermesClient } from "./hermes/client";
import { HermesError, describeError } from "./hermes/errors";
import type { TunnelController } from "./tunnel/tunnel";

export type TestStep = {
	status: "ok" | "error" | "warn" | "info";
	text: string;
};

export type TestReport = {
	ok: boolean;
	steps: TestStep[];
};

const REQUIRED_FEATURES = ["run_submission", "run_status", "run_events_sse", "run_stop"];

/**
 * Checks the whole chain step by step — tunnel, Hermes reachability, API key — so a failure names
 * the broken link. If a tunnel is configured but not running, a temporary one is opened for the
 * test and closed again afterwards.
 */
export async function runConnectionTest(client: HermesClient, tunnel: TunnelController): Promise<TestReport> {
	const steps: TestStep[] = [];
	const config = tunnel.config;
	let openedForTest = false;

	try {
		if (config?.sshHost) {
			if (tunnel.owned) {
				steps.push({ status: "ok", text: `Tunnel to ${config.sshHost} is running.` });
			} else {
				const outcome = await tunnel.start();
				const status = tunnel.status;
				if (outcome === "external") {
					steps.push({ status: "info", text: `Port ${config.localPort} is already open (tunnel outside Stream Deck) – using it.` });
				} else if (outcome === "busy") {
					steps.push({ status: "info", text: "The tunnel is starting right now – run the test again in a moment." });
					return { ok: false, steps };
				} else if (outcome === "invalid") {
					steps.push({ status: "error", text: `Tunnel settings: ${status.detail ?? "invalid"}.` });
					return { ok: false, steps };
				} else if (status.state === "connected" || status.state === "no_hermes") {
					openedForTest = true;
					steps.push({ status: "ok", text: `SSH tunnel to ${config.sshHost} opened (for this test only).` });
				} else {
					steps.push({ status: "error", text: `SSH to ${config.sshHost}: ${status.detail ?? "failed"}.` });
					steps.push({ status: "info", text: "Hermes not checked because the tunnel is missing." });
					return { ok: false, steps };
				}
			}
			const mismatch = portMismatch(client.baseUrl, config.localPort);
			if (mismatch) steps.push({ status: "warn", text: mismatch });
		} else {
			steps.push({ status: "info", text: "No tunnel set up – checking the Hermes URL directly." });
		}

		try {
			const health = await client.health();
			steps.push({ status: "ok", text: `Hermes ${health.version ?? "(unknown version)"} reachable at ${client.baseUrl}.` });
		} catch (err) {
			const hint = config?.sshHost ? " The tunnel is up – is the Hermes API server running on the target host?" : "";
			steps.push({ status: "error", text: `Hermes at ${client.baseUrl || "(no URL)"}: ${describeError(err)}.${hint}` });
			return { ok: false, steps };
		}

		if (!client.configured) {
			steps.push({ status: "error", text: 'No API key entered (field "API key" in a Start Run key).' });
			return { ok: false, steps };
		}
		try {
			const caps = await client.capabilities();
			steps.push({ status: "ok", text: "API key valid." });
			const missing = REQUIRED_FEATURES.filter((f) => caps.features[f] !== true);
			if (missing.length > 0) steps.push({ status: "warn", text: `Hermes reports missing features: ${missing.join(", ")}.` });
		} catch (err) {
			const text = err instanceof HermesError && err.kind === "auth" ? "Invalid API key (Hermes rejects it)." : `API key check: ${describeError(err)}.`;
			steps.push({ status: "error", text });
			return { ok: false, steps };
		}
		return { ok: true, steps };
	} finally {
		if (openedForTest) {
			await tunnel.stop();
			steps.push({ status: "info", text: "Test tunnel closed again." });
		}
	}
}

/** Warns when the Hermes URL points at localhost on a different port than the tunnel. */
export function portMismatch(baseUrl: string, tunnelPort: number): string | undefined {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		return undefined;
	}
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
		return `Hermes URL points to ${url.host}, not to the tunnel (127.0.0.1:${tunnelPort}).`;
	}
	const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
	return port === tunnelPort ? undefined : `Hermes URL uses port ${port}, the tunnel port ${tunnelPort}.`;
}
