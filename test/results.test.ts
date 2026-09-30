import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fileName, renderMarkdown, ResultStore, type RunResult } from "../src/results/store";

const RESULT: RunResult = {
	title: "Mail/Draft: \"Customer\"?",
	runId: "run_abc",
	phase: "completed",
	startedAt: new Date(2026, 8, 28, 20, 5, 0).getTime(),
	endedAt: new Date(2026, 8, 28, 20, 5, 42).getTime(),
	prompt: "Write a reply:\n```\nquote\n```",
	model: "some-model",
	output: "Hello customer,\n\nthank you.",
};

let dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs) await rm(d, { recursive: true, force: true });
	dirs = [];
});

async function tempStore() {
	const dir = await mkdtemp(join(tmpdir(), "hsd-results-"));
	dirs.push(dir);
	return { dir, store: new ResultStore(async () => join(dir, "Hermes Streamdeck")) };
}

describe("result files", () => {
	it("builds safe, sortable file names", () => {
		expect(fileName(RESULT.title, new Date(RESULT.endedAt))).toBe("2026-09-28 20-05-42 Mail Draft Customer.md");
		expect(fileName("...", new Date(RESULT.endedAt))).toBe("2026-09-28 20-05-42 Run.md");
	});

	it("renders status, prompt and answer; fences survive backticks in the prompt", () => {
		const md = renderMarkdown(RESULT);
		expect(md).toContain("# Mail/Draft: \"Customer\"?");
		expect(md).toContain("- **Status:** Done");
		expect(md).toContain("- **Run:** `run_abc`");
		expect(md).toContain("- **Model:** some-model");
		expect(md).toContain("````\nWrite a reply:\n```\nquote\n```\n````");
		expect(md).toContain("## Answer\n\nHello customer,\n\nthank you.");
	});

	it("marks denied approvals and missing answers", () => {
		const md = renderMarkdown({ ...RESULT, output: undefined, denied: true, error: "boom" });
		expect(md).toContain("Done – at least one approval was denied");
		expect(md).toContain("_(no answer)_");
		expect(md).toContain("## Error");
	});

	it("notes steer text that never reached the agent", () => {
		expect(renderMarkdown(RESULT)).not.toContain("Steer not delivered");
		const md = renderMarkdown({ ...RESULT, pendingSteer: "focus on tests" });
		expect(md).toContain("## Steer not delivered");
		expect(md).toContain("```\nfocus on tests\n```");
	});

	it("writes into the folder (creating it) without overwriting", async () => {
		const { dir, store } = await tempStore();
		const a = await store.write(RESULT);
		const b = await store.write(RESULT);
		expect(a).toBe(join(dir, "Hermes Streamdeck", "2026-09-28 20-05-42 Mail Draft Customer.md"));
		expect(b).toBe(join(dir, "Hermes Streamdeck", "2026-09-28 20-05-42 Mail Draft Customer (2).md"));
		expect(await readFile(a, "utf8")).toContain("Hello customer");
	});

	it("cleans up only its own old files", async () => {
		const { dir, store } = await tempStore();
		const folder = join(dir, "Hermes Streamdeck");
		const old = await store.write(RESULT);
		const fresh = await store.write({ ...RESULT, endedAt: RESULT.endedAt + 1000 });
		const foreign = join(folder, "my-notes.md");
		await writeFile(foreign, "private");
		const longAgo = new Date(Date.now() - 40 * 86_400_000);
		await utimes(old, longAgo, longAgo);
		await utimes(foreign, longAgo, longAgo);

		expect(await store.cleanup(30)).toBe(1);
		expect((await readdir(folder)).sort()).toEqual([fresh, foreign].map((p) => p.slice(folder.length + 1)).sort());
		expect(await store.cleanup(0)).toBe(0); // 0 = keep forever
	});
});
