/**
 * Prompt placeholders, resolved when a Start Run key is pressed:
 *
 *   {{clipboard}}  text from the clipboard
 *   {{input}}      text typed into a dialog
 *   {{date}}       e.g. 2026-09-28
 *   {{time}}       e.g. 20:15
 *
 * Names are case-insensitive and may have inner spaces (`{{ Date }}`). The German names of earlier
 * versions ({{zwischenablage}}, {{eingabe}}, {{datum}}, {{uhrzeit}}) still work as aliases. Unknown
 * placeholders are left as they are. Values are inserted in a single pass, so placeholder-like text
 * inside the clipboard or the input is never expanded again.
 */

export const MAX_CLIPBOARD_CHARS = 50_000;

export type PlaceholderName = "clipboard" | "input" | "date" | "time";

const PATTERN = /\{\{\s*([A-Za-zÄÖÜäöü]+)\s*\}\}/g;

const NAMES: Readonly<Record<string, PlaceholderName>> = {
	clipboard: "clipboard",
	input: "input",
	date: "date",
	time: "time",
	// Aliases from the German-only 0.1 versions.
	zwischenablage: "clipboard",
	eingabe: "input",
	datum: "date",
	uhrzeit: "time",
};

export type TemplateSources = {
	clipboard: () => Promise<string>;
	/** Resolves undefined if the user cancelled. */
	input: () => Promise<string | undefined>;
	now: () => Date;
};

export type ResolveResult =
	| { ok: true; prompt: string; used: PlaceholderName[] }
	| { ok: false; reason: "clipboard_empty" | "clipboard_too_large" | "input_cancelled" | "input_empty" | "clipboard_failed" | "input_failed" };

function canonical(name: string): PlaceholderName | undefined {
	return NAMES[name.toLowerCase()];
}

/** Placeholders a template uses, in order of first appearance. */
export function placeholdersIn(template: string): PlaceholderName[] {
	const found: PlaceholderName[] = [];
	for (const match of template.matchAll(PATTERN)) {
		const name = canonical(match[1]!);
		if (name && !found.includes(name)) found.push(name);
	}
	return found;
}

export async function resolvePrompt(template: string, sources: TemplateSources): Promise<ResolveResult> {
	const used = placeholdersIn(template);
	const values = new Map<PlaceholderName, string>();
	const now = sources.now();

	// Clipboard first: the input dialog could change what the user has copied.
	if (used.includes("clipboard")) {
		let text: string;
		try {
			text = await sources.clipboard();
		} catch {
			return { ok: false, reason: "clipboard_failed" };
		}
		text = text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
		if (text.trim() === "") return { ok: false, reason: "clipboard_empty" };
		if (text.length > MAX_CLIPBOARD_CHARS) return { ok: false, reason: "clipboard_too_large" };
		values.set("clipboard", text);
	}
	if (used.includes("input")) {
		let text: string | undefined;
		try {
			text = await sources.input();
		} catch {
			return { ok: false, reason: "input_failed" };
		}
		if (text === undefined) return { ok: false, reason: "input_cancelled" };
		if (text.trim() === "") return { ok: false, reason: "input_empty" };
		values.set("input", text.trim());
	}
	const pad = (n: number) => n.toString().padStart(2, "0");
	values.set("date", `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
	values.set("time", `${pad(now.getHours())}:${pad(now.getMinutes())}`);

	const prompt = template.replace(PATTERN, (whole, name: string) => {
		const key = canonical(name);
		return (key && values.get(key)) ?? whole;
	});
	return { ok: true, prompt, used };
}

/** Short key text for a failed resolution. */
export function describeResolveFailure(reason: Extract<ResolveResult, { ok: false }>["reason"]): string {
	switch (reason) {
		case "clipboard_empty":
			return "Clipboard empty";
		case "clipboard_too_large":
			return "Clipboard too big";
		case "clipboard_failed":
			return "Clipboard error";
		case "input_cancelled":
			return "Cancelled";
		case "input_empty":
			return "Input empty";
		case "input_failed":
			return "Dialog error";
	}
}
