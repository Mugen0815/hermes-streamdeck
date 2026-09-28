import { describe, expect, it } from "vitest";

import { SseParser } from "../src/hermes/sse";

describe("SseParser", () => {
	it("parses the Hermes stream format (id + JSON data, comment lines)", () => {
		const p = new SseParser();
		const out = p.push(': open\n\nid: 0\ndata: {"event": "message.delta", "seq": 0}\n\nid: 1\ndata: {"event": "run.completed"}\n\n: stream closed\n\n');
		expect(out).toEqual([
			{ id: "0", data: '{"event": "message.delta", "seq": 0}' },
			{ id: "1", data: '{"event": "run.completed"}' },
		]);
	});

	it("handles events split across arbitrary chunks and CRLF line endings", () => {
		const p = new SseParser();
		const input = "id: 7\r\ndata: {\"a\":1}\r\n\r\nid: 8\r\ndata: x\r\n\r\n";
		const out = [];
		for (const ch of input) out.push(...p.push(ch));
		expect(out).toEqual([
			{ id: "7", data: '{"a":1}' },
			{ id: "8", data: "x" },
		]);
	});

	it("joins multi-line data and keeps the last id for following events", () => {
		const p = new SseParser();
		expect(p.push("id: 3\ndata: a\ndata: b\n\ndata: c\n\n")).toEqual([
			{ id: "3", data: "a\nb" },
			{ id: "3", data: "c" },
		]);
	});

	it("does not dispatch blocks without data and ignores keepalive comments", () => {
		const p = new SseParser();
		expect(p.push(": keepalive\n\nid: 5\n\nretry: 100\n\n")).toEqual([]);
	});

	it("passes through an explicit event field", () => {
		const p = new SseParser();
		expect(p.push("event: ping\ndata: {}\n\n")).toEqual([{ event: "ping", data: "{}" }]);
	});
});
