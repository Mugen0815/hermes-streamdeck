import { isTerminalPhase, type RunPhase, type RunSnapshot } from "../runs/state";
import type { ConnectionState } from "../connection";
import type { TunnelStatus } from "../tunnel/tunnel";

/**
 * Key images are generated as 144×144 SVGs. The user's own Stream Deck title is drawn by the app on
 * top (titles are aligned to the top in the manifest); the image carries the status.
 */

type Glyph = "play" | "dots" | "spinner" | "hand" | "square" | "check" | "cross" | "question" | "bolt" | "plug" | "plugOn" | "key";

const PLUG = `<path d="M60 52 V64 M84 52 V64" fill="none" stroke-width="6" stroke-linecap="round"/><path d="M54 64 H90 V74 A18 18 0 0 1 54 74 Z" stroke="none"/><path d="M72 92 V100" fill="none" stroke-width="6" stroke-linecap="round"/>`;

type Look = { bg: string; glyph: Glyph; label: string };

const LOOKS: Record<RunPhase, Look> = {
	idle: { bg: "#1f2a37", glyph: "play", label: "Ready" },
	checking: { bg: "#334155", glyph: "dots", label: "Checking…" },
	starting: { bg: "#1e40af", glyph: "dots", label: "Starting…" },
	running: { bg: "#1d4ed8", glyph: "spinner", label: "Running" },
	approval: { bg: "#b45309", glyph: "hand", label: "Approval?" },
	stopping: { bg: "#c2410c", glyph: "square", label: "Stopping…" },
	completed: { bg: "#15803d", glyph: "check", label: "Done" },
	cancelled: { bg: "#4b5563", glyph: "square", label: "Stopped" },
	failed: { bg: "#b91c1c", glyph: "cross", label: "Failed" },
	interrupted: { bg: "#9f1239", glyph: "bolt", label: "Interrupted" },
	lost: { bg: "#52525b", glyph: "question", label: "Unknown" },
	start_failed: { bg: "#b91c1c", glyph: "cross", label: "Start failed" },
};

export type StartKeyView = {
	snapshot: RunSnapshot;
	connection: ConnectionState;
	now: number;
	/** A press on the finished key opens the result file. */
	resultOnPress?: boolean;
};

export function renderStartKey(view: StartKeyView): string {
	const { snapshot, connection } = view;
	let look = LOOKS[snapshot.phase];
	let detail = snapshot.detail;

	if (snapshot.phase === "idle") {
		if (connection === "offline") look = { bg: "#3f3f46", glyph: "plug", label: "Offline" };
		else if (connection === "auth") look = { bg: "#7f1d1d", glyph: "key", label: "API key?" };
		else if (connection === "not_configured") look = { bg: "#3f3f46", glyph: "key", label: "Set up" };
	}

	let label = look.label;
	if (snapshot.phase === "running" && snapshot.startedAt) {
		label = `${look.label} ${formatElapsed(view.now - snapshot.startedAt)}`;
	}
	if (snapshot.phase === "approval") {
		// Time since the request (falls back to run start), and what kind of action waits.
		const since = snapshot.approval?.requestedAt ?? snapshot.startedAt;
		if (since) label = `${look.label} ${formatElapsed(view.now - since)}`;
		detail = snapshot.approval?.description || "press for details";
	}
	if (isTerminalPhase(snapshot.phase) && snapshot.resultFile && view.resultOnPress && !detail) detail = "press for result";
	if (snapshot.phase === "completed" && snapshot.denied) detail = "denied";
	if (snapshot.reconnecting) detail = "no connection";

	return svg(look.bg, look.glyph, label, detail, snapshot.reconnecting === true);
}

export type StopKeyView = {
	/** Phase of the targeted run, or undefined when there is none. */
	targetPhase: RunPhase | undefined;
	targetName: string;
	/** Transient feedback after a press, e.g. "No run". */
	flash?: string;
};

export function renderStopKey(view: StopKeyView): string {
	const phase = view.targetPhase;
	if (view.flash) return svg("#52525b", "square", view.flash, view.targetName, false);
	if (phase === "stopping") return svg("#c2410c", "square", "Stopping…", view.targetName, false);
	if (phase && isTerminalPhase(phase)) {
		// Mirror the unacknowledged result; pressing Stop now acknowledges it.
		const look = LOOKS[phase];
		return svg(look.bg, look.glyph, look.label, view.targetName, false);
	}
	if (phase === "running" || phase === "approval" || phase === "checking" || phase === "starting") {
		return svg("#b91c1c", "square", "Stop", view.targetName, false);
	}
	return svg("#27272a", "square", "No run", view.targetName, false, 0.45);
}

export function renderTunnelKey(status: TunnelStatus, host: string | undefined, flash?: string): string {
	const where = host || "not set up";
	if (flash) return svg("#52525b", "plug", flash, status.detail ?? where, false);
	switch (status.state) {
		case "off":
			return svg("#3f3f46", "plug", "Tunnel off", status.detail ?? where, false);
		case "connecting":
			return svg("#1e40af", "dots", "Connecting…", where, false);
		case "connected":
			return svg("#15803d", "plugOn", "Connected", where, false);
		case "no_hermes":
			return svg("#b45309", "plugOn", "Hermes down", where, true);
		case "external":
			return svg("#334155", "plugOn", "External", status.detail ?? "", status.hermesOk !== true);
		case "error":
			return svg("#b91c1c", "cross", "Tunnel error", status.detail ?? "", true);
	}
}

export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function svg(bg: string, glyph: Glyph, label: string, detail: string | undefined, warn: boolean, glyphOpacity = 1): string {
	const parts = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`,
		`<rect width="144" height="144" fill="${bg}"/>`,
		`<g fill="#ffffff" stroke="#ffffff" opacity="${glyphOpacity}">${glyphSvg(glyph)}</g>`,
		text(label, 116, 20, 700),
	];
	if (detail) parts.push(text(truncate(detail, 18), 136, 13, 400, warn ? "#fde68a" : "#e5e7eb"));
	parts.push("</svg>");
	return `data:image/svg+xml;charset=utf8,${encodeURIComponent(parts.join(""))}`;
}

function text(value: string, y: number, size: number, weight: number, fill = "#ffffff"): string {
	return `<text x="72" y="${y}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeXml(truncate(value, 14))}</text>`;
}

function glyphSvg(glyph: Glyph): string {
	// Glyphs live in the band y≈52..96 so the app-drawn title at the top stays readable.
	switch (glyph) {
		case "play":
			return `<path d="M60 52 L92 74 L60 96 Z" stroke="none"/>`;
		case "dots":
			return `<circle cx="52" cy="74" r="6" stroke="none"/><circle cx="72" cy="74" r="6" stroke="none"/><circle cx="92" cy="74" r="6" stroke="none"/>`;
		case "spinner":
			return `<circle cx="72" cy="74" r="20" fill="none" stroke-width="7" opacity="0.3"/><path d="M72 54 A20 20 0 0 1 92 74" fill="none" stroke-width="7" stroke-linecap="round"/>`;
		case "hand":
			return `<text x="72" y="92" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="48" font-weight="700" stroke="none">?</text>`;
		case "square":
			return `<rect x="54" y="56" width="36" height="36" rx="4" stroke="none"/>`;
		case "check":
			return `<path d="M52 75 L66 89 L94 59" fill="none" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`;
		case "cross":
			return `<path d="M56 58 L88 90 M88 58 L56 90" fill="none" stroke-width="9" stroke-linecap="round"/>`;
		case "question":
			return `<text x="72" y="92" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="48" font-weight="700" stroke="none">?</text>`;
		case "bolt":
			return `<path d="M78 50 L58 78 L72 78 L66 98 L88 68 L74 68 Z" stroke="none"/>`;
		case "plug":
			return `${PLUG}<path d="M50 98 L96 54" fill="none" stroke="#ef4444" stroke-width="5" stroke-linecap="round"/>`;
		case "plugOn":
			return PLUG;
		case "key":
			return `<circle cx="60" cy="74" r="13" fill="none" stroke-width="7"/><path d="M73 74 H96 M88 74 V84 M96 74 V82" fill="none" stroke-width="7" stroke-linecap="round"/>`;
	}
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function escapeXml(value: string): string {
	return value.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
}
