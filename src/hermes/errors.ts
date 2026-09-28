/**
 * Error categories the rest of the plugin can react to without knowing HTTP details.
 */
export type HermesErrorKind =
	| "not_configured" // base URL or API key missing
	| "unreachable" // connection refused, DNS failure, tunnel down
	| "timeout" // no response within the request timeout
	| "auth" // 401/403 — API key missing or wrong
	| "not_found" // run (or endpoint) does not exist on the server
	| "conflict" // 409, e.g. idempotency key reused with a different payload
	| "rate_limited" // 429, concurrent run cap reached
	| "bad_request" // other 4xx
	| "server" // 5xx
	| "bad_response"; // response could not be parsed or lacks required fields

/**
 * Error raised by {@link HermesClient}. Messages never contain the API key or request bodies.
 */
export class HermesError extends Error {
	constructor(
		readonly kind: HermesErrorKind,
		message: string,
		readonly status?: number,
		readonly code?: string,
	) {
		super(message);
		this.name = "HermesError";
	}

	/** True when retrying the same request later may succeed. */
	get transient(): boolean {
		return this.kind === "unreachable" || this.kind === "timeout" || this.kind === "server";
	}
}

/**
 * Short, user-facing text for a key or the property inspector.
 */
export function describeError(err: unknown): string {
	if (!(err instanceof HermesError)) return "Unexpected error";
	switch (err.kind) {
		case "not_configured":
			return "Not configured";
		case "unreachable":
			return "Hermes unreachable";
		case "timeout":
			return "Timed out";
		case "auth":
			return "Invalid API key";
		case "not_found":
			return "Not found";
		case "conflict":
			return "Conflict";
		case "rate_limited":
			return "Too many runs";
		case "bad_request":
			return "Request rejected";
		case "server":
			return "Server error";
		case "bad_response":
			return "Invalid response";
	}
}

/**
 * Converts a thrown fetch error (network level) into a {@link HermesError}.
 */
export function fromFetchError(err: unknown): HermesError {
	if (err instanceof HermesError) return err;
	const name = (err as { name?: string } | undefined)?.name;
	if (name === "TimeoutError") return new HermesError("timeout", "Request timed out");
	const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
	const code = cause?.code;
	return new HermesError("unreachable", code ? `Connection failed (${code})` : "Connection failed");
}
