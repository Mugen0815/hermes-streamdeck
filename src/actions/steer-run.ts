import streamDeck, {
	action,
	type DidReceiveSettingsEvent,
	type KeyDownEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
} from "@elgato/streamdeck";

import { type App, type JsonValue, STEER_ACTION_UUID, type SteerSettings } from "../app";
import { describeResolveFailure, resolvePrompt } from "../prompt/template";
import type { SteerOutcome } from "../runs/manager";
import { renderSteerKey } from "../ui/render";
import { handleInspectorMessage } from "./start-run";

const FLASH_MS = 2_500;

const OUTCOME_TEXT: Record<Exclude<SteerOutcome, "queued">, string> = {
	no_run: "No run",
	not_running: "Not running",
	not_accepted: "Not accepted",
	failed: "Steer failed",
};

/**
 * Sends the configured text to the running run of one Start Run key — an explicitly selected key or
 * the most recently started one. Hermes queues the text until the agent's next tool boundary, so the
 * key reports "Queued", not "done".
 */
@action({ UUID: STEER_ACTION_UUID })
export class SteerRunAction extends SingletonAction<SteerSettings> {
	readonly #app: App;
	readonly #settings = new Map<string, SteerSettings>();
	readonly #flash = new Map<string, { text: string; ok: boolean; timer: ReturnType<typeof setTimeout> }>();
	/** Keys resolving placeholders (e.g. input dialog open); further presses are refused meanwhile. */
	readonly #busy = new Set<string>();

	constructor(app: App) {
		super();
		this.#app = app;
		app.onRunChange(() => this.#renderAll());
	}

	override async onWillAppear(ev: WillAppearEvent<SteerSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		await this.#render(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SteerSettings>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		await this.#render(ev.action.id);
	}

	override async onKeyDown(ev: KeyDownEvent<SteerSettings>): Promise<void> {
		const id = ev.action.id;
		const settings = ev.payload.settings;
		this.#settings.set(id, settings);
		if (this.#busy.has(id)) {
			await ev.action.showAlert();
			return;
		}

		const target = this.#app.resolveTarget(settings.target);
		const phase = target ? this.#app.manager.snapshot(target).phase : undefined;
		// Check before asking for input: nobody wants to type a message for a run that is not running.
		if (!target || phase !== "running") {
			await ev.action.showAlert();
			this.#flashText(id, phase === "approval" || phase === "stopping" || phase === "starting" || phase === "checking" ? "Not running" : "No run", false);
			return;
		}
		if (!settings.text?.trim()) {
			await ev.action.showAlert();
			this.#flashText(id, "No text", false);
			return;
		}

		this.#busy.add(id);
		let outcome: SteerOutcome;
		try {
			const resolved = await resolvePrompt(settings.text, {
				clipboard: () => this.#app.desktop.readClipboard(),
				input: () => this.#app.desktop.askInput(`Steer: ${this.#app.startKeyName(target)}`),
				now: () => new Date(),
			});
			if (!resolved.ok) {
				if (resolved.reason !== "input_cancelled") {
					await ev.action.showAlert();
					this.#flashText(id, describeResolveFailure(resolved.reason), false);
				}
				return;
			}
			outcome = await this.#app.manager.steer(target, resolved.prompt);
		} finally {
			this.#busy.delete(id);
		}

		if (outcome === "queued") {
			await ev.action.showOk();
			this.#flashText(id, "Queued", true);
		} else {
			await ev.action.showAlert();
			this.#flashText(id, OUTCOME_TEXT[outcome], false);
		}
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SteerSettings>): Promise<void> {
		await handleInspectorMessage(this.#app, ev.payload);
	}

	#flashText(id: string, text: string, ok: boolean): void {
		clearTimeout(this.#flash.get(id)?.timer);
		const timer = setTimeout(() => {
			this.#flash.delete(id);
			void this.#render(id);
		}, FLASH_MS);
		this.#flash.set(id, { text, ok, timer });
		void this.#render(id);
	}

	#renderAll(): void {
		for (const a of this.actions) void this.#render(a.id);
	}

	async #render(id: string): Promise<void> {
		const a = streamDeck.actions.getActionById(id);
		if (!a || !a.isKey() || a.manifestId !== STEER_ACTION_UUID) return;

		const explicit = this.#settings.get(id)?.target;
		const target = this.#app.resolveTarget(explicit);
		const phase = target ? this.#app.manager.snapshot(target).phase : undefined;
		const flash = this.#flash.get(id);
		await a.setImage(renderSteerKey({ targetPhase: phase, targetName: this.#app.targetLabel(explicit, target), flash }));
	}
}
