import { HermesClient } from "./hermes/client";
import { HermesError, describeError } from "./hermes/errors";

export type ConnectionState = "unknown" | "ok" | "offline" | "auth" | "not_configured";

export type GlobalSettings = {
	baseUrl?: string;
	apiKey?: string;
	/** SSH host or ~/.ssh/config alias for the Tunnel action. */
	tunnelHost?: string;
	/** Ports/host as entered in the property inspector (text fields). */
	tunnelLocalPort?: string;
	tunnelRemoteHost?: string;
	tunnelRemotePort?: string;
	/** Days to keep result files (0 = forever); text field. */
	resultsRetentionDays?: string;
};

export const DEFAULT_BASE_URL = "http://127.0.0.1:8642";

export type ConnectionTestResult = {
	ok: boolean;
	state: ConnectionState;
	message: string;
};

/**
 * Holds the current Hermes client (rebuilt when global settings change) and periodically checks
 * reachability and authentication so idle keys can show "offline" / "API key?" instead of "ready".
 */
export class Connection {
	#client: HermesClient;
	#state: ConnectionState = "unknown";
	#timer: ReturnType<typeof setInterval> | undefined;
	#checking: Promise<ConnectionTestResult> | undefined;
	readonly #listeners = new Set<(state: ConnectionState) => void>();
	readonly #log: (message: string) => void;

	constructor(log: (message: string) => void = () => {}) {
		this.#client = new HermesClient({ baseUrl: DEFAULT_BASE_URL, apiKey: "" });
		this.#log = log;
	}

	get client(): HermesClient {
		return this.#client;
	}

	get state(): ConnectionState {
		return this.#state;
	}

	onChange(listener: (state: ConnectionState) => void): void {
		this.#listeners.add(listener);
	}

	/** Applies new global settings and re-checks the connection. */
	configure(settings: GlobalSettings): void {
		const baseUrl = settings.baseUrl?.trim() || DEFAULT_BASE_URL;
		const apiKey = settings.apiKey ?? "";
		this.#client = new HermesClient({ baseUrl, apiKey });
		void this.check();
	}

	startMonitoring(intervalMs = 30_000): void {
		clearInterval(this.#timer);
		this.#timer = setInterval(() => void this.check(), intervalMs);
	}

	/** Checks health (reachability) and capabilities (API key). Concurrent calls share one check. */
	check(): Promise<ConnectionTestResult> {
		this.#checking ??= this.#check().finally(() => (this.#checking = undefined));
		return this.#checking;
	}

	async #check(): Promise<ConnectionTestResult> {
		const client = this.#client;
		let result: ConnectionTestResult;
		try {
			const health = await client.health();
			if (!client.configured) {
				result = { ok: false, state: "not_configured", message: `Hermes ${health.version ?? ""} reachable, but no API key entered.` };
			} else {
				const caps = await client.capabilities();
				const missing = ["run_submission", "run_status", "run_events_sse", "run_stop"].filter((f) => caps.features[f] !== true);
				result = missing.length === 0
					? { ok: true, state: "ok", message: `Connected to Hermes ${health.version ?? "(unknown version)"}.` }
					: { ok: true, state: "ok", message: `Connected, but features are missing: ${missing.join(", ")}.` };
			}
		} catch (err) {
			const state: ConnectionState = err instanceof HermesError && err.kind === "auth" ? "auth"
				: err instanceof HermesError && err.kind === "not_configured" ? "not_configured"
				: "offline";
			result = { ok: false, state, message: `${describeError(err)} (${client.baseUrl || "no URL"}).` };
			this.#log(`connection check failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (client === this.#client) this.#setState(result.state);
		return result;
	}

	#setState(state: ConnectionState): void {
		if (state === this.#state) return;
		this.#log(`connection state: ${this.#state} -> ${state}`);
		this.#state = state;
		for (const listener of this.#listeners) listener(state);
	}
}
