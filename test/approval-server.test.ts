import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { ApprovalServer } from "../src/approval/server";
import type { ApprovalChoice, PendingApproval } from "../src/hermes/types";
import type { ApprovalOutcome } from "../src/runs/manager";
import type { RunSnapshot } from "../src/runs/state";

const APPROVAL: PendingApproval = { command: "rm -r /tmp/x", description: "delete in root path", requestId: "req-1", choices: ["once", "deny"] };

let servers: ApprovalServer[] = [];
afterEach(async () => {
	for (const s of servers) await s.stop();
	servers = [];
});

async function setup(snapshot: RunSnapshot = { phase: "approval", runId: "run_1", approval: APPROVAL }) {
	const calls: { keyId: string; requestId?: string; choice: ApprovalChoice }[] = [];
	const server = new ApprovalServer({
		manager: {
			snapshot: () => snapshot,
			respondApproval: async (keyId: string, requestId: string | undefined, choice: ApprovalChoice): Promise<ApprovalOutcome> => {
				calls.push({ keyId, requestId, choice });
				return "answered";
			},
		},
		keyName: () => "Test",
		log: () => {},
	});
	servers.push(server);
	await server.start();
	const token = new URL(server.urlFor("abc123")).searchParams.get("t")!;
	return { server, calls, token };
}

type Res = { status: number; body: string; headers: Record<string, unknown> };

function call(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
		});
		req.on("error", reject);
		if (opts.body) req.write(opts.body);
		req.end();
	});
}

describe("ApprovalServer", () => {
	it("serves the page only with the token and a matching Host header", async () => {
		const { server, token } = await setup();
		const ok = await call(server.port, `/approval/abc123?t=${token}`);
		expect(ok.status).toBe(200);
		expect(ok.body).toContain("Hermes – Approval");
		expect(String(ok.headers["content-security-policy"])).toContain("default-src 'none'");

		expect((await call(server.port, "/approval/abc123?t=wrong")).status).toBe(403);
		expect((await call(server.port, "/approval/abc123")).status).toBe(403);
		const rebinding = await call(server.port, `/approval/abc123?t=${token}`, { headers: { Host: "evil.example:1234" } });
		expect(rebinding.status).toBe(403);
	});

	it("returns the pending approval via the API with the token header only", async () => {
		const { server, token } = await setup();
		expect((await call(server.port, "/api/abc123")).status).toBe(403);
		expect((await call(server.port, `/api/abc123?t=${token}`)).status).toBe(403);
		const res = await call(server.port, "/api/abc123", { headers: { "X-Approval-Token": token } });
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ keyName: "Test", runId: "run_1", phase: "approval", denied: false, approval: APPROVAL });
	});

	it("answers with the exact request id and validates input", async () => {
		const { server, token, calls } = await setup();
		const headers = { "X-Approval-Token": token, "Content-Type": "application/json" };
		const res = await call(server.port, "/api/abc123", { method: "POST", headers, body: JSON.stringify({ requestId: "req-1", choice: "deny" }) });
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body).outcome).toBe("answered");
		expect(calls).toEqual([{ keyId: "abc123", requestId: "req-1", choice: "deny" }]);

		expect((await call(server.port, "/api/abc123", { method: "POST", headers, body: JSON.stringify({ choice: "yolo" }) })).status).toBe(400);
		expect((await call(server.port, "/api/abc123", { method: "POST", headers, body: "{" })).status).toBe(400);
		const plain = await call(server.port, "/api/abc123", {
			method: "POST",
			headers: { "X-Approval-Token": token, "Content-Type": "text/plain" },
			body: "{}",
		});
		expect(plain.status).toBe(415);
		expect(calls).toHaveLength(1);
	});

	it("rejects malformed key ids and unknown paths", async () => {
		const { server, token } = await setup();
		expect((await call(server.port, `/approval/..%2F..?t=${token}`)).status).toBe(404);
		expect((await call(server.port, `/approval/abc123/extra?t=${token}`)).status).toBe(404);
		expect((await call(server.port, `/other/abc123?t=${token}`)).status).toBe(404);
	});

	it("does not expose an approval when the run is not waiting", async () => {
		const { server, token } = await setup({ phase: "running", runId: "run_1", approval: APPROVAL });
		const res = await call(server.port, "/api/abc123", { headers: { "X-Approval-Token": token } });
		expect(JSON.parse(res.body).approval).toBeNull();
	});
});
