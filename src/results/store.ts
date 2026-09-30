import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunPhase, SteerRecord } from "../runs/state";

export const RESULTS_FOLDER_NAME = "Hermes Streamdeck";
export const DEFAULT_RETENTION_DAYS = 30;

/** Only files matching this pattern are ever deleted by the retention cleanup. */
const OUR_FILE = /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2} .+\.md$/;
const MAX_PROMPT_CHARS = 20_000;

export type RunResult = {
	title: string;
	runId: string;
	phase: RunPhase;
	startedAt?: number;
	endedAt: number;
	prompt: string;
	model?: string;
	output?: string;
	error?: string;
	denied?: boolean;
	pendingSteer?: string;
	steers?: SteerRecord[];
};

const STATUS_TEXT: Partial<Record<RunPhase, string>> = {
	completed: "Done",
	failed: "Failed",
	cancelled: "Stopped",
	interrupted: "Interrupted (Hermes restarted)",
};

/**
 * Writes one Markdown file per finished run into `Documents\Hermes Streamdeck` and removes our own
 * files older than the retention period.
 */
export class ResultStore {
	readonly #dir: () => Promise<string>;
	readonly #log: (message: string) => void;

	constructor(dir: () => Promise<string>, log: (message: string) => void = () => {}) {
		this.#dir = dir;
		this.#log = log;
	}

	async write(result: RunResult): Promise<string> {
		const dir = await this.#dir();
		await mkdir(dir, { recursive: true });
		const path = join(dir, fileName(result.title, new Date(result.endedAt)));
		// "wx": never overwrite; add a suffix on the rare same-second collision.
		for (let i = 0; ; i++) {
			const candidate = i === 0 ? path : path.replace(/\.md$/, ` (${i + 1}).md`);
			try {
				await writeFile(candidate, renderMarkdown(result), { encoding: "utf8", flag: "wx" });
				return candidate;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST" || i > 20) throw err;
			}
		}
	}

	/** Deletes result files older than `days` (0 = keep forever). Returns the number removed. */
	async cleanup(days: number, now = Date.now()): Promise<number> {
		if (!Number.isFinite(days) || days <= 0) return 0;
		const dir = await this.#dir();
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return 0;
		}
		const cutoff = now - days * 86_400_000;
		let removed = 0;
		for (const name of names) {
			if (!OUR_FILE.test(name)) continue;
			const path = join(dir, name);
			try {
				const info = await stat(path);
				if (info.isFile() && info.mtimeMs < cutoff) {
					await unlink(path);
					removed++;
				}
			} catch (err) {
				this.#log(`result cleanup skipped a file: ${String(err)}`);
			}
		}
		if (removed > 0) this.#log(`removed ${removed} result file(s) older than ${days} days`);
		return removed;
	}
}

/** Local time as `YYYY-MM-DD HH<sep>MM<sep>SS`. */
function timestamp(at: Date, sep: string): string {
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}${sep}${pad(at.getMinutes())}${sep}${pad(at.getSeconds())}`;
}

export function fileName(title: string, at: Date): string {
	const stamp = timestamp(at, "-");
	const safe = title
		.replace(/[\u0000-\u001f<>:"/\\|?*]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[. ]+$/, "")
		.slice(0, 60) || "Run";
	return `${stamp} ${safe}.md`;
}

export function renderMarkdown(r: RunResult): string {
	const fmt = (ms: number | undefined) => (ms ? timestamp(new Date(ms), ":") : "–");
	let status = STATUS_TEXT[r.phase] ?? r.phase;
	if (r.denied) status += " – at least one approval was denied";
	const prompt = r.prompt.length > MAX_PROMPT_CHARS ? `${r.prompt.slice(0, MAX_PROMPT_CHARS)}\n\n… (truncated)` : r.prompt;

	const lines = [
		`# ${r.title}`,
		"",
		`- **Status:** ${status}`,
		`- **Started:** ${fmt(r.startedAt)}`,
		`- **Finished:** ${fmt(r.endedAt)}`,
		`- **Run:** \`${r.runId}\``,
	];
	if (r.model) lines.push(`- **Model:** ${r.model}`);
	lines.push("", "## Prompt", "", fence(prompt), "");
	if (r.steers?.length) {
		lines.push("## Steer", "");
		for (const s of r.steers) lines.push(`**${timestamp(new Date(s.at), ":").slice(11)}**`, "", fence(s.text), "");
	}
	lines.push("## Answer", "");
	lines.push(r.output?.trim() ? r.output.trim() : "_(no answer)_");
	if (r.error) lines.push("", "## Error", "", fence(r.error));
	if (r.pendingSteer) lines.push("", "## Steer not delivered", "", "The run ended before the agent received this steer text:", "", fence(r.pendingSteer));
	lines.push("");
	return lines.join("\n");
}

/** Code fence that cannot be closed by the content itself. */
function fence(text: string): string {
	const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	const ticks = "`".repeat(longest + 1);
	return `${ticks}\n${text}\n${ticks}`;
}
