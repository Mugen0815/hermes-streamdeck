import streamDeck from "@elgato/streamdeck";

import { Connection, type ConnectionState, type GlobalSettings } from "./connection";
import { ApprovalServer } from "./approval/server";
import { runConnectionTest, type TestReport } from "./connection-test";
import { DEFAULT_TUNNEL, TunnelController, type TunnelConfig, systemTunnelDeps } from "./tunnel/tunnel";
import { RunManager, type PersistedRun } from "./runs/manager";
import { DEFAULT_RETENTION_DAYS, RESULTS_FOLDER_NAME, ResultStore } from "./results/store";
import type { StartRunRequest } from "./hermes/types";
import type { RunSnapshot } from "./runs/state";
import { type Desktop, systemDesktop } from "./system/desktop";
import { join } from "node:path";

export const PLUGIN_UUID = "io.github.mugen0815.hermes-streamdeck";
export const START_ACTION_UUID = `${PLUGIN_UUID}.start-run`;
export const STOP_ACTION_UUID = `${PLUGIN_UUID}.stop-run`;
export const TUNNEL_ACTION_UUID = `${PLUGIN_UUID}.tunnel`;

/**
 * What happens with a finished run's result file:
 * - ack_open: opened when the finished key is pressed (default)
 * - auto_open: opened as soon as the run ends
 * - clipboard: answer copied to the clipboard as soon as the run ends
 * - save: only saved
 */
export type AfterRun = "ack_open" | "auto_open" | "clipboard" | "save";

export type StartSettings = {
	prompt?: string;
	model?: string;
	afterRun?: AfterRun;
	run?: PersistedRun;
};

export type StopSettings = {
	/** Action id of the targeted Start Run key; empty = most recently started run. */
	target?: string;
};

const logger = streamDeck.logger.createScope("hermes");
export const log = (message: string): void => void logger.info(message);

/** JSON value as accepted by the Stream Deck messaging APIs. */
export type JsonValue = Parameters<typeof streamDeck.ui.sendToPropertyInspector>[0];
export type JsonObject = Parameters<typeof streamDeck.settings.setGlobalSettings>[0];

/**
 * Shared plugin state: connection, run manager and what we know about Start Run keys.
 * Actions subscribe to changes here instead of talking to each other directly.
 */
export class App {
	readonly connection = new Connection(log);
	readonly tunnel = new TunnelController(systemTunnelDeps(log));
	readonly manager: RunManager;
	readonly approvals: ApprovalServer;
	readonly desktop: Desktop = systemDesktop;
	readonly results: ResultStore;
	#retentionDays = DEFAULT_RETENTION_DAYS;
	/** Latest known settings per Start Run key (needed to merge persisted run data). */
	readonly startSettings = new Map<string, StartSettings>();
	/** User-visible titles of Start Run keys, from the Stream Deck title field. */
	readonly startTitles = new Map<string, string>();
	readonly #runListeners = new Set<(keyId: string, snapshot: RunSnapshot) => void>();

	constructor() {
		this.manager = new RunManager({
			client: () => this.connection.client,
			persist: (keyId, run) => void this.persistRun(keyId, run),
			onChange: (keyId, snapshot) => {
				for (const listener of this.#runListeners) listener(keyId, snapshot);
			},
			onFinished: (keyId, snapshot, request) => void this.#handleFinished(keyId, snapshot, request),
			log,
		});
		this.results = new ResultStore(async () => join(await this.desktop.documentsDir(), RESULTS_FOLDER_NAME), log);
		this.approvals = new ApprovalServer({ manager: this.manager, keyName: (id) => this.startKeyName(id), log });
		// Tunnel up/down changes reachability; re-check so idle keys switch between Offline and Ready.
		this.tunnel.onChange(() => void this.connection.check());
	}

	/** Applies global settings to the Hermes connection and the tunnel. */
	async applyGlobalSettings(settings: GlobalSettings): Promise<void> {
		this.connection.configure(settings);
		const days = Number(settings.resultsRetentionDays?.trim() || DEFAULT_RETENTION_DAYS);
		this.#retentionDays = Number.isFinite(days) && days >= 0 ? days : DEFAULT_RETENTION_DAYS;
		await this.tunnel.configure(tunnelConfigFrom(settings)).catch((err) => log(`tunnel configure failed: ${String(err)}`));
	}

	/**
	 * Runs the step-by-step connection test for the property inspector. Concurrent requests (e.g. a
	 * double click) share one run.
	 */
	testConnection(): Promise<TestReport> {
		this.#test ??= (async () => {
			// Re-read global settings so the test uses what was just typed, even if the change event is pending.
			await this.applyGlobalSettings(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
			const report = await runConnectionTest(this.connection.client, this.tunnel);
			void this.connection.check();
			return report;
		})().finally(() => (this.#test = undefined));
		return this.#test;
	}

	#test: Promise<TestReport> | undefined;

	/** Removes old result files according to the retention setting. */
	cleanupResults(): Promise<number> {
		return this.results.cleanup(this.#retentionDays).catch((err) => {
			log(`result cleanup failed: ${String(err)}`);
			return 0;
		});
	}

	/** Writes the result file of a finished run and applies the key's "after run" setting. */
	async #handleFinished(keyId: string, snapshot: RunSnapshot, request: StartRunRequest | undefined): Promise<void> {
		if (!snapshot.runId || snapshot.phase === "lost" || snapshot.phase === "start_failed") return;
		const afterRun = this.startSettings.get(keyId)?.afterRun ?? "ack_open";
		let path: string;
		try {
			path = await this.results.write({
				title: this.startKeyName(keyId),
				runId: snapshot.runId,
				phase: snapshot.phase,
				startedAt: snapshot.startedAt,
				endedAt: snapshot.endedAt ?? Date.now(),
				prompt: request?.input ?? "(unknown – the run was started before Stream Deck restarted)",
				model: request?.model,
				output: snapshot.output,
				error: snapshot.error,
				denied: snapshot.denied,
			});
		} catch (err) {
			log(`writing result file failed: ${String(err)}`);
			return;
		}
		log(`result for run ${snapshot.runId} saved`);
		this.manager.attachResult(keyId, snapshot.runId, path);

		if (afterRun === "auto_open") {
			await this.desktop.openFile(path).catch((err) => log(`opening result failed: ${String(err)}`));
		} else if (afterRun === "clipboard" && snapshot.output?.trim()) {
			const key = streamDeck.actions.getActionById(keyId);
			try {
				await this.desktop.writeClipboard(snapshot.output.trim());
				if (key?.isKey()) await key.showOk();
			} catch (err) {
				log(`copying result failed: ${String(err)}`);
				if (key?.isKey()) await key.showAlert();
			}
		}
		void this.cleanupResults();
	}

	onRunChange(listener: (keyId: string, snapshot: RunSnapshot) => void): void {
		this.#runListeners.add(listener);
	}

	onConnectionChange(listener: (state: ConnectionState) => void): void {
		this.connection.onChange(listener);
	}

	/** Display name of a Start Run key for Stop keys and the property inspector. */
	startKeyName(keyId: string): string {
		const title = this.startTitles.get(keyId)?.replace(/\s+/g, " ").trim();
		if (title) return title;
		const prompt = this.startSettings.get(keyId)?.prompt?.replace(/\s+/g, " ").trim();
		if (prompt) return prompt.length > 16 ? `${prompt.slice(0, 15)}…` : prompt;
		return "Start Run";
	}

	/**
	 * Writes the run into the key's action settings, merged with its latest known settings. If the
	 * key is not visible right now, the Start action re-persists when it next appears.
	 */
	async persistRun(keyId: string, run: PersistedRun | undefined): Promise<void> {
		const current = this.startSettings.get(keyId) ?? {};
		const next: StartSettings = { ...current };
		if (run) next.run = run;
		else delete next.run;
		this.startSettings.set(keyId, next);

		const action = streamDeck.actions.getActionById(keyId);
		if (!action) return;
		try {
			await action.setSettings(next);
		} catch (err) {
			log(`persisting run for ${keyId} failed: ${String(err)}`);
		}
	}
}

export function tunnelConfigFrom(settings: GlobalSettings): TunnelConfig {
	const port = (value: string | undefined, fallback: number) => {
		const trimmed = value?.trim();
		return trimmed ? Number(trimmed) : fallback;
	};
	return {
		sshHost: settings.tunnelHost?.trim() ?? "",
		localPort: port(settings.tunnelLocalPort, DEFAULT_TUNNEL.localPort),
		remoteHost: settings.tunnelRemoteHost?.trim() || DEFAULT_TUNNEL.remoteHost,
		remotePort: port(settings.tunnelRemotePort, DEFAULT_TUNNEL.remotePort),
	};
}

export function sameRun(a: PersistedRun | undefined, b: PersistedRun | undefined): boolean {
	if (!a || !b) return a === b;
	return a.runId === b.runId && a.phase === b.phase && (a.denied ?? false) === (b.denied ?? false) && a.resultFile === b.resultFile;
}
