import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
} from "@elgato/streamdeck";

import { type App, type JsonValue, START_ACTION_UUID, STOP_ACTION_UUID, type StopSettings } from "../app";
import { isTerminalPhase } from "../runs/state";
import { renderStopKey } from "../ui/render";
import { handleInspectorMessage } from "./start-run";

const FLASH_MS = 2_500;

/**
 * Stops the run of one Start Run key — either an explicitly selected key or the most recently
 * started one. The key always shows which Start key it targets. Once that run has ended, a press
 * acknowledges the result and resets the Start key.
 */
@action({ UUID: STOP_ACTION_UUID })
export class StopRunAction extends SingletonAction<StopSettings> {
	readonly #app: App;
	readonly #settings = new Map<string, StopSettings>();
	readonly #flash = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();
	/** Stop keys that sent a stop and wait for the confirmed terminal state. */
	readonly #pending = new Map<string, string>();

	constructor(app: App) {
		super();
		this.#app = app;
		app.onRunChange((keyId, snapshot) => {
			for (const [stopId, targetKey] of this.#pending) {
				if (targetKey !== keyId || snapshot.phase === "stopping") continue;
				this.#pending.delete(stopId);
				const a = streamDeck.actions.getActionById(stopId);
				// Confirmed stop only; if the run ended some other way the key simply shows that state.
				if (a?.isKey() && snapshot.phase === "cancelled") void a.showOk();
			}
			this.#renderAll();
		});
	}

	override async onWillAppear(ev: WillAppearEvent<StopSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		await this.#render(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<StopSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		await this.#render(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<StopSettings>): Promise<void> {
		const id = ev.action.id;
		this.#settings.set(id, ev.payload.settings);
		const target = this.#target(id);

		// The target's run already ended: this press acknowledges it and resets the Start key.
		if (target && isTerminalPhase(this.#app.manager.snapshot(target).phase)) {
			this.#app.manager.reset(target);
			await this.#render(id);
			return;
		}

		const outcome = target ? await this.#app.manager.stop(target) : "no_run";
		switch (outcome) {
			case "requested":
				this.#pending.set(id, target!);
				break;
			case "already_stopping":
				break;
			case "no_run":
				await ev.action.showAlert();
				this.#flashText(id, "No run");
				break;
			case "failed":
				await ev.action.showAlert();
				this.#flashText(id, "Stop failed");
				break;
		}
		await this.#render(id);
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, StopSettings>): Promise<void> {
		const payload = ev.payload as { event?: unknown } | null;
		if (payload && typeof payload === "object" && payload.event === "getStartKeys") {
			const items = [{ value: "", label: "Most recently started run" }];
			for (const a of streamDeck.actions) {
				if (a.manifestId === START_ACTION_UUID) items.push({ value: a.id, label: this.#app.startKeyName(a.id) });
			}
			await streamDeck.ui.sendToPropertyInspector({ event: "getStartKeys", items });
			return;
		}
		await handleInspectorMessage(this.#app, ev.payload);
	}

	#target(stopId: string): string | undefined {
		const explicit = this.#settings.get(stopId)?.target;
		return explicit ? explicit : this.#app.manager.lastStartedKey;
	}

	#flashText(id: string, text: string): void {
		clearTimeout(this.#flash.get(id)?.timer);
		const timer = setTimeout(() => {
			this.#flash.delete(id);
			void this.#render(id);
		}, FLASH_MS);
		this.#flash.set(id, { text, timer });
	}

	#renderAll(): void {
		for (const a of this.actions) void this.#render(a.id);
	}

	async #render(id: string): Promise<void> {
		const a = streamDeck.actions.getActionById(id);
		if (!a || !a.isKey() || a.manifestId !== STOP_ACTION_UUID) return;

		const explicit = this.#settings.get(id)?.target;
		const target = this.#target(id);
		let targetName: string;
		if (target) targetName = explicit ? this.#app.startKeyName(target) : `↻ ${this.#app.startKeyName(target)}`;
		else targetName = explicit ? "target missing" : "last started";

		const phase = target ? this.#app.manager.snapshot(target).phase : undefined;
		await a.setImage(renderStopKey({ targetPhase: phase, targetName, flash: this.#flash.get(id)?.text }));
	}
}
