/**
 * A single server-sent event as far as this plugin needs it.
 */
export type SseMessage = {
	id?: string;
	event?: string;
	data: string;
};

/**
 * Minimal incremental parser for `text/event-stream` (WHATWG spec subset):
 * handles CRLF/LF/CR line endings, comment lines (`:`), multi-line `data`, `id` and `event` fields,
 * and chunks that split lines at arbitrary positions.
 */
export class SseParser {
	#buffer = "";
	#data: string[] = [];
	#id: string | undefined;
	#event: string | undefined;
	#hasField = false;

	/**
	 * Feeds decoded text and returns all events completed by it.
	 */
	push(chunk: string): SseMessage[] {
		this.#buffer += chunk;
		const out: SseMessage[] = [];

		for (;;) {
			const match = /\r\n|\r|\n/.exec(this.#buffer);
			if (!match) break;
			// A lone trailing CR may be the first half of CRLF; wait for more input.
			if (match[0] === "\r" && match.index === this.#buffer.length - 1) break;

			const line = this.#buffer.slice(0, match.index);
			this.#buffer = this.#buffer.slice(match.index + match[0].length);
			const msg = this.#line(line);
			if (msg) out.push(msg);
		}
		return out;
	}

	#line(line: string): SseMessage | undefined {
		if (line === "") return this.#dispatch();
		if (line.startsWith(":")) return undefined;

		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);

		switch (field) {
			case "data":
				this.#data.push(value);
				this.#hasField = true;
				break;
			case "id":
				if (!value.includes("\0")) this.#id = value;
				this.#hasField = true;
				break;
			case "event":
				this.#event = value;
				this.#hasField = true;
				break;
			default:
				// "retry" and unknown fields are ignored.
				break;
		}
		return undefined;
	}

	#dispatch(): SseMessage | undefined {
		if (!this.#hasField) return undefined;
		const data = this.#data;
		const event = this.#event;
		this.#data = [];
		this.#event = undefined;
		this.#hasField = false;
		// Per spec a block without data is not dispatched; the last event id persists either way.
		if (data.length === 0) return undefined;

		const msg: SseMessage = { data: data.join("\n") };
		if (this.#id !== undefined) msg.id = this.#id;
		if (event !== undefined) msg.event = event;
		return msg;
	}
}
