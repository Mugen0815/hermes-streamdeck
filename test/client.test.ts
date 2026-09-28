import { describe, expect, it } from "vitest";

import { HermesClient, normalizeBaseUrl, type FetchLike } from "../src/hermes/client";
import { HermesError } from "../src/hermes/errors";
import type { RunEvent } from "../src/hermes/types";

const KEY = "test-key-0123456789abcdefghijklmnopqrstuvwxyz";

type Call = { url: string; init: RequestInit | undefined };

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		fetch: async (url, init) => {
			calls.push({ url, init });
			return handler(url, init);
		},
	};
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function client(fetch: FetchLike, streamIdleTimeoutMs?: number) {
	return new HermesClient({ baseUrl: "http://127.0.0.1:8642", apiKey: KEY, fetch, streamIdleTimeoutMs });
}

function header(init: RequestInit | undefined, name: string): string | undefined {
	return (init?.headers as Record<string, string> | undefined)?.[name];
}

describe("HermesClient", () => {
	it("starts a run with bearer auth, idempotency key and JSON body", async () => {
		const m = mockFetch(() => json(202, { run_id: "run_abc", status: "started", replayed: false }));
		const result = await client(m.fetch).startRun({ input: "Hello world – üöä ✓", model: "some-model" }, "idem-1");

		expect(result).toEqual({ runId: "run_abc", status: "started", replayed: false });
		const call = m.calls[0]!;
		expect(call.url).toBe("http://127.0.0.1:8642/v1/runs");
		expect(call.init?.method).toBe("POST");
		expect(header(call.init, "Authorization")).toBe(`Bearer ${KEY}`);
		expect(header(call.init, "Idempotency-Key")).toBe("idem-1");
		expect(JSON.parse(call.init?.body as string)).toEqual({ input: "Hello world – üöä ✓", model: "some-model" });
	});

	it("omits empty optional fields", async () => {
		const m = mockFetch(() => json(202, { run_id: "run_abc", status: "started" }));
		await client(m.fetch).startRun({ input: "x", model: "" }, "k");
		expect(JSON.parse(m.calls[0]!.init?.body as string)).toEqual({ input: "x" });
	});

	it("reports replayed idempotent starts", async () => {
		const m = mockFetch(() => json(202, { run_id: "run_abc", status: "running", replayed: true }, { "Idempotency-Replayed": "true" }));
		expect((await client(m.fetch).startRun({ input: "x" }, "k")).replayed).toBe(true);
	});

	it("rejects a start response without run_id", async () => {
		const m = mockFetch(() => json(202, { status: "started" }));
		await expect(client(m.fetch).startRun({ input: "x" }, "k")).rejects.toMatchObject({ kind: "bad_response" });
	});

	it("maps 401 to auth errors without leaking the key", async () => {
		const m = mockFetch(() => json(401, { error: { message: "Invalid gateway API key (API_SERVER_KEY)", code: "gateway_auth_failed" } }));
		const err = await client(m.fetch).getRun("run_x").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(HermesError);
		expect(err).toMatchObject({ kind: "auth", status: 401, code: "gateway_auth_failed" });
		expect(String((err as Error).message)).not.toContain(KEY);
	});

	it("maps 404 run_not_found and non-JSON 404 bodies", async () => {
		const a = mockFetch(() => json(404, { error: { message: "Run not found: run_x", code: "run_not_found" } }));
		await expect(client(a.fetch).getRun("run_x")).rejects.toMatchObject({ kind: "not_found", code: "run_not_found" });
		const b = mockFetch(() => new Response("404: Not Found", { status: 404 }));
		await expect(client(b.fetch).getRun("run_x")).rejects.toMatchObject({ kind: "not_found" });
	});

	it("maps 409 and 429", async () => {
		const a = mockFetch(() => json(409, { error: { code: "idempotency_key_conflict", message: "..." } }));
		await expect(client(a.fetch).startRun({ input: "x" }, "k")).rejects.toMatchObject({ kind: "conflict" });
		const b = mockFetch(() => json(429, { error: { message: "too many" } }));
		await expect(client(b.fetch).startRun({ input: "x" }, "k")).rejects.toMatchObject({ kind: "rate_limited" });
	});

	it("maps connection failures to unreachable", async () => {
		const m = mockFetch(() => {
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		});
		const err = await client(m.fetch).health().catch((e: unknown) => e);
		expect(err).toMatchObject({ kind: "unreachable" });
		expect((err as HermesError).transient).toBe(true);
	});

	it("maps request timeouts", async () => {
		const m = mockFetch(() => {
			throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
		});
		await expect(client(m.fetch).getRun("run_x")).rejects.toMatchObject({ kind: "timeout" });
	});

	it("refuses authenticated calls without an API key", async () => {
		const m = mockFetch(() => json(200, {}));
		const c = new HermesClient({ baseUrl: "http://127.0.0.1:8642", apiKey: "  ", fetch: m.fetch });
		expect(c.configured).toBe(false);
		await expect(c.getRun("run_x")).rejects.toMatchObject({ kind: "not_configured" });
		expect(m.calls).toHaveLength(0);
	});

	it("health does not send the API key", async () => {
		const m = mockFetch(() => json(200, { status: "ok", platform: "hermes-agent", version: "0.21.5" }));
		expect(await client(m.fetch).health()).toEqual({ status: "ok", platform: "hermes-agent", version: "0.21.5" });
		expect(header(m.calls[0]!.init, "Authorization")).toBeUndefined();
	});

	it("reads run status fields", async () => {
		const m = mockFetch(() =>
			json(200, { object: "hermes.run", run_id: "run_x", status: "cancelled", last_event: "run.cancelled", turn_exit_reason: "interrupted_by_user" }),
		);
		expect(await client(m.fetch).getRun("run_x")).toEqual({
			runId: "run_x",
			status: "cancelled",
			lastEvent: "run.cancelled",
			turnExitReason: "interrupted_by_user",
		});
	});

	it("streams events with the event name taken from the JSON payload", async () => {
		// Captured from Hermes 0.21.5 (shortened).
		const body = [
			": open\n\n",
			'id: 0\ndata: {"event": "tool.started", "run_id": "run_x", "tool": "terminal", "seq": 0}\n\n',
			'id: 1\ndata: {"event": "tool.comp',
			'leted", "run_id": "run_x", "seq": 1}\n\nid: 2\ndata: {"event": "run.cancelled", "run_id": "run_x", "seq": 2}\n\n',
			": stream closed\n\n",
		];
		const m = mockFetch(() => new Response(new Blob(body).stream(), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
		const events: RunEvent[] = [];
		await client(m.fetch).streamEvents("run_x", { lastEventId: "4", onEvent: (e) => events.push(e) });

		expect(events.map((e) => [e.id, e.event])).toEqual([
			["0", "tool.started"],
			["1", "tool.completed"],
			["2", "run.cancelled"],
		]);
		expect(m.calls[0]!.url).toBe("http://127.0.0.1:8642/v1/runs/run_x/events");
		expect(header(m.calls[0]!.init, "Last-Event-ID")).toBe("4");
	});

	it("reports a 404 event stream as not_found", async () => {
		const m = mockFetch(() => new Response("404: Not Found", { status: 404 }));
		await expect(client(m.fetch).streamEvents("run_x", { onEvent: () => {} })).rejects.toMatchObject({ kind: "not_found" });
	});

	it("aborts a silent stream after the idle timeout", async () => {
		const m = mockFetch((_url, init) => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(": open\n\n"));
					init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
				},
			});
			return new Response(stream, { status: 200 });
		});
		await expect(client(m.fetch, 50).streamEvents("run_x", { onEvent: () => {} })).rejects.toMatchObject({ kind: "timeout" });
	});

	it("returns quietly when the caller aborts the stream", async () => {
		const m = mockFetch((_url, init) => {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
				},
			});
			return new Response(stream, { status: 200 });
		});
		const ac = new AbortController();
		const p = client(m.fetch).streamEvents("run_x", { signal: ac.signal, onEvent: () => {} });
		setTimeout(() => ac.abort(), 10);
		await expect(p).resolves.toBeUndefined();
	});
});

describe("approvals in the client", () => {
	it("sends choice (not decision) and the request id", async () => {
		const m = mockFetch(() => json(200, { object: "hermes.run.approval_response", choice: "deny", request_id: "r1", resolved: 1 }));
		await client(m.fetch).respondApproval("run_x", "deny", "r1");
		expect(m.calls[0]!.url).toBe("http://127.0.0.1:8642/v1/runs/run_x/approval");
		expect(JSON.parse(m.calls[0]!.init?.body as string)).toEqual({ choice: "deny", request_id: "r1" });
	});

	it("maps approval_not_pending to conflict", async () => {
		const m = mockFetch(() => json(409, { error: { code: "approval_not_pending", message: "Run has no pending approval" } }));
		await expect(client(m.fetch).respondApproval("run_x", "once")).rejects.toMatchObject({ kind: "conflict", code: "approval_not_pending" });
	});

	it("reads the pending approval from the run status, dropping unknown choices", async () => {
		const m = mockFetch(() =>
			json(200, {
				run_id: "run_x",
				status: "waiting_for_approval",
				approval: { command: "rm -r /tmp/x", description: "delete in root path", request_id: "r1", choices: ["once", "deny", "bogus"], timestamp: 10.5 },
			}),
		);
		expect((await client(m.fetch).getRun("run_x")).approval).toEqual({
			command: "rm -r /tmp/x",
			description: "delete in root path",
			requestId: "r1",
			choices: ["once", "deny"],
			requestedAt: 10500,
		});
	});
});

describe("normalizeBaseUrl", () => {
	it.each([
		["http://127.0.0.1:8642", "http://127.0.0.1:8642"],
		["http://127.0.0.1:8642/", "http://127.0.0.1:8642"],
		["http://127.0.0.1:8642/v1", "http://127.0.0.1:8642"],
		["localhost:8642", "http://localhost:8642"],
		["  https://example.test/  ", "https://example.test"],
		["", ""],
	])("%s -> %s", (input, expected) => {
		expect(normalizeBaseUrl(input)).toBe(expected);
	});
});
