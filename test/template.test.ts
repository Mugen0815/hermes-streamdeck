import { describe, expect, it } from "vitest";

import { MAX_CLIPBOARD_CHARS, placeholdersIn, resolvePrompt, type TemplateSources } from "../src/prompt/template";

const NOW = new Date(2026, 8, 28, 20, 5, 0);

function sources(overrides: Partial<TemplateSources> = {}) {
	const calls = { clipboard: 0, input: 0 };
	const s: TemplateSources = {
		clipboard: async () => {
			calls.clipboard++;
			return "Text from the clipboard\r\n";
		},
		input: async () => {
			calls.input++;
			return "  typed in  ";
		},
		now: () => NOW,
		...overrides,
	};
	return { s, calls };
}

describe("prompt placeholders", () => {
	it("finds placeholders case-insensitively with inner spaces", () => {
		expect(placeholdersIn("A {{ Clipboard }} B {{input}} {{DATE}} {{time}} {{unknown}} {{date}}")).toEqual(["clipboard", "input", "date", "time"]);
	});

	it("accepts the German names of earlier versions as aliases", () => {
		expect(placeholdersIn("{{zwischenablage}} {{Eingabe}} {{datum}} {{uhrzeit}}")).toEqual(["clipboard", "input", "date", "time"]);
	});

	it("resolves all placeholders and leaves unknown ones", async () => {
		const { s } = sources();
		const r = await resolvePrompt("Summarize: {{clipboard}} | {{input}} | {{date}} {{time}} | {{foo}} | {{datum}}", s);
		expect(r).toEqual({
			ok: true,
			prompt: "Summarize: Text from the clipboard | typed in | 2026-09-28 20:05 | {{foo}} | 2026-09-28",
			used: ["clipboard", "input", "date", "time"],
		});
	});

	it("does not touch clipboard or dialog when not used", async () => {
		const { s, calls } = sources();
		const r = await resolvePrompt("Only {{date}}", s);
		expect(r).toMatchObject({ ok: true, prompt: "Only 2026-09-28" });
		expect(calls).toEqual({ clipboard: 0, input: 0 });
	});

	it("never expands placeholders inside inserted text", async () => {
		const { s } = sources({ clipboard: async () => "{{input}} {{date}}" });
		const r = await resolvePrompt("X {{clipboard}}", s);
		expect(r).toMatchObject({ ok: true, prompt: "X {{input}} {{date}}" });
	});

	it("refuses an empty or oversized clipboard", async () => {
		expect(await resolvePrompt("{{clipboard}}", sources({ clipboard: async () => "  \n" }).s)).toEqual({ ok: false, reason: "clipboard_empty" });
		expect(await resolvePrompt("{{clipboard}}", sources({ clipboard: async () => "x".repeat(MAX_CLIPBOARD_CHARS + 1) }).s)).toEqual({
			ok: false,
			reason: "clipboard_too_large",
		});
		expect(await resolvePrompt("{{clipboard}}", sources({ clipboard: async () => Promise.reject(new Error("x")) }).s)).toEqual({
			ok: false,
			reason: "clipboard_failed",
		});
	});

	it("handles a cancelled or empty input dialog", async () => {
		expect(await resolvePrompt("{{input}}", sources({ input: async () => undefined }).s)).toEqual({ ok: false, reason: "input_cancelled" });
		expect(await resolvePrompt("{{input}}", sources({ input: async () => "   " }).s)).toEqual({ ok: false, reason: "input_empty" });
	});

	it("reads the clipboard before opening the dialog", async () => {
		const order: string[] = [];
		const { s } = sources({
			clipboard: async () => (order.push("clipboard"), "c"),
			input: async () => (order.push("input"), "i"),
		});
		await resolvePrompt("{{input}} {{clipboard}}", s);
		expect(order).toEqual(["clipboard", "input"]);
	});
});
