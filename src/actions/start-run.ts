import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type SendToPluginEvent,
	SingletonAction,
	type TitleParametersDidChangeEvent,
	type WillAppearEvent,
} from "@elgato/streamdeck";

import { type App, type JsonValue, START_ACTION_UUID, type StartSettings, log, sameRun } from "../app";
import { describeResolveFailure, resolvePrompt } from "../prompt/template";
import { isActivePhase, isTerminalPhase } from "../runs/state";
import { renderStartKey } from "../ui/render";

/**
 * Starts the configured prompt as a Hermes run and shows that run's state on the key.
 *
 * Pressing while the key's run is still active is ignored (the key flashes an alert). A finished run
 * stays on the key until a press (here or on a Stop key targeting it) acknowledges it; the next press
 * then starts a new run.
 */
@action({ UUID: START_ACTION_UUID })
export class StartRunAction extends SingletonAction<StartSettings> {
	readonly #app: App;

	constructor(app: App) {
		super();
		this.#app = app;
		app.onRunChange((keyId) => void this.#render(keyId));
		app.onConnectionChange(() => {
			for (const a of this.actions) void this.#render(a.id);
		});
		// Keep the elapsed time on running keys current.
		setInterval(() => {
			for (const a of this.actions) {
				const phase = app.manager.snapshot(a.id).phase;
				if (phase === "running" || phase === "approval") void this.#render(a.id);
			}
		}, 1_000);
	}

	override async onWillAppear(ev: WillAppearEvent<StartSettings>): Promise<void> {
		const id = ev.action.id;
		const settings = ev.payload.settings;
		this.#app.startSettings.set(id, settings);
		this.#app.manager.restore(id, settings.run);
		await this.#healPersistedRun(id, settings);
		await this.#render(id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<StartSettings>): Promise<void> {
		const id = ev.action.id;
		this.#app.startSettings.set(id, ev.payload.settings);
		// The property inspector may write back settings it loaded before a run changed; restore ours.
		await this.#healPersistedRun(id, ev.payload.settings);
		await this.#render(id);
	}

	override onTitleParametersDidChange(ev: TitleParametersDidChangeEvent<StartSettings>): void {
		this.#app.startTitles.set(ev.action.id, ev.payload.title);
	}

	override async onKeyDown(ev: KeyDownEvent<StartSettings>): Promise<void> {
		const id = ev.action.id;
		const settings = ev.payload.settings;
		this.#app.startSettings.set(id, { ...settings, run: this.#app.startSettings.get(id)?.run ?? settings.run });

		const snapshot = this.#app.manager.snapshot(id);
		const phase = snapshot.phase;
		// Approvals are answered on a local page that shows the full request, never blindly on the key.
		if (phase === "approval" && this.#app.approvals.port) {
			await streamDeck.system.openUrl(this.#app.approvals.urlFor(id));
			return;
		}
		if (isActivePhase(phase) || this.#preparing.has(id)) {
			await ev.action.showAlert();
			return;
		}
		// A finished run stays visible until acknowledged; this press acknowledges it and, depending on
		// the key's setting, opens the result file.
		if (isTerminalPhase(phase)) {
			if (snapshot.resultFile && (settings.afterRun ?? "ack_open") === "ack_open") {
				await this.#app.desktop.openFile(snapshot.resultFile).catch((err) => log(`opening result failed: ${String(err)}`));
			}
			this.#app.manager.reset(id);
			return;
		}

		// Resolve placeholders ({{zwischenablage}}, {{eingabe}}, …). The dialog may stay open for a
		// while; further presses are refused meanwhile.
		this.#preparing.add(id);
		let resolved;
		try {
			resolved = await resolvePrompt(settings.prompt ?? "", {
				clipboard: () => this.#app.desktop.readClipboard(),
				input: () => this.#app.desktop.askInput(this.#app.startKeyName(id)),
				now: () => new Date(),
			});
		} finally {
			this.#preparing.delete(id);
		}
		if (!resolved.ok) {
			if (resolved.reason === "input_cancelled") return; // user changed their mind: nothing happened
			await ev.action.showAlert();
			this.#app.manager.failBeforeStart(id, describeResolveFailure(resolved.reason));
			return;
		}

		const outcome = await this.#app.manager.start(id, {
			input: resolved.prompt,
			model: settings.model?.trim() || undefined,
		});
		if (outcome === "failed") await ev.action.showAlert();
		// A start failure may mean the connection is gone; refresh the idle indicator.
		if (outcome === "failed") void this.#app.connection.check();
	}

	/** Keys whose placeholders are being resolved (e.g. input dialog open). */
	readonly #preparing = new Set<string>();

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, StartSettings>): Promise<void> {
		await handleInspectorMessage(this.#app, ev.payload);
	}

	async #healPersistedRun(id: string, settings: StartSettings): Promise<void> {
		const snapshot = this.#app.manager.snapshot(id);
		if (!snapshot.runId) return;
		const expected = {
			runId: snapshot.runId,
			phase: snapshot.phase,
			startedAt: snapshot.startedAt,
			endedAt: snapshot.endedAt,
			...(snapshot.denied ? { denied: true } : {}),
			...(snapshot.resultFile ? { resultFile: snapshot.resultFile } : {}),
		};
		if (!sameRun(settings.run, expected)) await this.#app.persistRun(id, expected);
	}

	async #render(id: string): Promise<void> {
		const a = streamDeck.actions.getActionById(id);
		if (!a || !a.isKey() || a.manifestId !== START_ACTION_UUID) return;
		const image = renderStartKey({
			snapshot: this.#app.manager.snapshot(id),
			connection: this.#app.connection.state,
			now: Date.now(),
			resultOnPress: (this.#app.startSettings.get(id)?.afterRun ?? "ack_open") === "ack_open",
		});
		await a.setImage(image);
	}
}

/**
 * Messages from the property inspectors of both actions.
 */
export async function handleInspectorMessage(app: App, payload: JsonValue): Promise<void> {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
	const event = (payload as { event?: unknown }).event;

	if (event === "testConnection") {
		const report = await app.testConnection();
		log(`connection test: ${report.ok ? "ok" : "failed"} (${report.steps.map((s) => s.status).join(",")})`);
		await streamDeck.ui.sendToPropertyInspector({ event: "testConnectionResult", ok: report.ok, steps: report.steps });
	}
}
