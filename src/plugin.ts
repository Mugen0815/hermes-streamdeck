import streamDeck from "@elgato/streamdeck";

import { StartRunAction } from "./actions/start-run";
import { StopRunAction } from "./actions/stop-run";
import { TunnelAction } from "./actions/tunnel";
import { App, log } from "./app";
import type { GlobalSettings } from "./connection";

// "info" on purpose: "trace" would log every Stream Deck message, including global settings with the API key.
streamDeck.logger.setLevel("info");

const app = new App();

streamDeck.actions.registerAction(new StartRunAction(app));
streamDeck.actions.registerAction(new StopRunAction(app));
streamDeck.actions.registerAction(new TunnelAction(app));

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => void app.applyGlobalSettings(ev.settings));

// Take a tunnel started by this plugin down with it. If the process is killed hard, the next start
// adopts the orphaned ssh via its pid file.
process.once("exit", () => app.tunnel.dispose());

await streamDeck.connect();

try {
	await app.approvals.start();
} catch (err) {
	log(`approval page unavailable: ${String(err)}`);
}
await app.applyGlobalSettings(await streamDeck.settings.getGlobalSettings<GlobalSettings>());
app.connection.startMonitoring();
void app.cleanupResults();
log("plugin started");
