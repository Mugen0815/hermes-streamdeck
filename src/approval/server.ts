import { randomBytes, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { APPROVAL_CHOICES, type ApprovalChoice } from "../hermes/types";
import type { ApprovalOutcome, RunManager } from "../runs/manager";
import { APPROVAL_PAGE } from "./page";

export type ApprovalServerDeps = {
	manager: Pick<RunManager, "snapshot" | "respondApproval">;
	keyName: (keyId: string) => string;
	log: (message: string) => void;
};

const KEY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_BODY = 4_096;

/**
 * Small local web server for answering approvals with the full request in view.
 *
 * Protections: bound to 127.0.0.1 only; the Host header must match (defeats DNS rebinding); every
 * request needs a random per-session token (query for the page, `X-Approval-Token` header for the
 * API — a custom header also forces a CORS preflight, which this server never grants, so other
 * web pages cannot call it); strict CSP; answers are bound to the exact Hermes request id.
 */
export class ApprovalServer {
	readonly #deps: ApprovalServerDeps;
	readonly #token = randomBytes(24).toString("base64url");
	#server: Server | undefined;
	#port = 0;

	constructor(deps: ApprovalServerDeps) {
		this.#deps = deps;
	}

	get port(): number {
		return this.#port;
	}

	async start(port = 0): Promise<void> {
		if (this.#server) return;
		const server = createServer((req, res) => {
			this.#handle(req, res).catch((err) => {
				this.#deps.log(`approval server error: ${String(err)}`);
				if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "Internal error");
				else res.end();
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => resolve());
		});
		this.#server = server;
		this.#port = (server.address() as AddressInfo).port;
	}

	/** URL of the approval page for one Start Run key. */
	urlFor(keyId: string): string {
		return `http://127.0.0.1:${this.#port}/approval/${encodeURIComponent(keyId)}?t=${this.#token}`;
	}

	async stop(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.headers.host !== `127.0.0.1:${this.#port}`) return send(res, 403, "text/plain; charset=utf-8", "Forbidden");

		const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.#port}`);
		const [, area, keyId, extra] = url.pathname.split("/");
		if (extra !== undefined || !keyId || !KEY_ID.test(keyId)) return send(res, 404, "text/plain; charset=utf-8", "Not found");

		if (area === "approval" && req.method === "GET") {
			if (!this.#tokenOk(url.searchParams.get("t"))) return send(res, 403, "text/plain; charset=utf-8", "Link invalid or expired (Stream Deck restarted?). Please open it again from the key.");
			return send(res, 200, "text/html; charset=utf-8", APPROVAL_PAGE);
		}

		if (area !== "api") return send(res, 404, "text/plain; charset=utf-8", "Not found");
		const header = req.headers["x-approval-token"];
		if (!this.#tokenOk(typeof header === "string" ? header : null)) return json(res, 403, { error: "token" });

		if (req.method === "GET") return json(res, 200, this.#view(keyId));
		if (req.method === "POST") {
			if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "content-type" });
			const body = await readBody(req);
			let parsed: { requestId?: unknown; choice?: unknown };
			try {
				parsed = JSON.parse(body) as typeof parsed;
			} catch {
				return json(res, 400, { error: "json" });
			}
			const choice = parsed.choice;
			if (typeof choice !== "string" || !APPROVAL_CHOICES.includes(choice as ApprovalChoice)) return json(res, 400, { error: "choice" });
			const requestId = typeof parsed.requestId === "string" && parsed.requestId ? parsed.requestId : undefined;
			const outcome: ApprovalOutcome = await this.#deps.manager.respondApproval(keyId, requestId, choice as ApprovalChoice);
			return json(res, outcome === "answered" ? 200 : outcome === "failed" ? 502 : 409, { outcome, ...this.#view(keyId) });
		}
		return json(res, 405, { error: "method" });
	}

	#view(keyId: string) {
		const snapshot = this.#deps.manager.snapshot(keyId);
		return {
			keyName: this.#deps.keyName(keyId),
			runId: snapshot.runId ?? null,
			phase: snapshot.phase,
			denied: snapshot.denied === true,
			approval: snapshot.phase === "approval" && snapshot.approval ? snapshot.approval : null,
		};
	}

	#tokenOk(value: string | null): boolean {
		if (!value) return false;
		const a = Buffer.from(value);
		const b = Buffer.from(this.#token);
		return a.length === b.length && timingSafeEqual(a, b);
	}
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
	res.writeHead(status, {
		"Content-Type": type,
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
		"Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	});
	res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
	send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
