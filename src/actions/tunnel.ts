import streamDeck, { action, type KeyDownEvent, type SendToPluginEvent, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";

import { type App, type JsonObject, type JsonValue, TUNNEL_ACTION_UUID } from "../app";
import { renderTunnelKey } from "../ui/render";
import { handleInspectorMessage } from "./start-run";

const FLASH_MS = 2_500;

/**
 * Starts and stops the SSH tunnel to Hermes and shows its state. All Tunnel keys share the one
 * tunnel configured in the plugin's global settings.
 */
@action({ UUID: TUNNEL_ACTION_UUID })
export class TunnelAction extends SingletonAction {
	readonly #app: App;
	#flash: { text: string; timer: ReturnType<typeof setTimeout> } | undefined;

	constructor(app: App) {
		super();
		this.#app = app;
		app.tunnel.onChange(() => this.#renderAll());
	}

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		await this.#render(ev.action.id);
		void this.#app.tunnel.refresh();
	}

	override async onKeyDown(ev: KeyDownEvent): Promise<void> {
		const outcome = await this.#app.tunnel.toggle();
		switch (outcome) {
			case "external":
				// Not ours to stop (e.g. a manually started ssh); say so instead of silently doing nothing.
				await ev.action.showAlert();
				this.#flashText("External");
				break;
			case "invalid":
				await ev.action.showAlert();
				break;
			case "started":
				if (this.#app.tunnel.status.state === "connected") await ev.action.showOk();
				else if (this.#app.tunnel.status.state === "error") await ev.action.showAlert();
				break;
			case "stopped":
			case "busy":
				break;
		}
		this.#renderAll();
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
		await handleInspectorMessage(this.#app, ev.payload);
	}

	#flashText(text: string): void {
		clearTimeout(this.#flash?.timer);
		const timer = setTimeout(() => {
			this.#flash = undefined;
			this.#renderAll();
		}, FLASH_MS);
		this.#flash = { text, timer };
	}

	#renderAll(): void {
		for (const a of this.actions) void this.#render(a.id);
	}

	async #render(id: string): Promise<void> {
		const a = streamDeck.actions.getActionById(id);
		if (!a || !a.isKey() || a.manifestId !== TUNNEL_ACTION_UUID) return;
		await a.setImage(renderTunnelKey(this.#app.tunnel.status, this.#app.tunnel.config?.sshHost, this.#flash?.text));
	}
}
