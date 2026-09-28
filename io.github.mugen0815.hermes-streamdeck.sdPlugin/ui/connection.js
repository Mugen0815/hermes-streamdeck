// Shared "test connection" wiring for all property inspectors.
(function () {
	const { streamDeckClient } = SDPIComponents;
	const button = document.getElementById("test-connection");
	const result = document.getElementById("test-result");
	const ICONS = { ok: "✓", error: "✗", warn: "!", info: "–" };

	button.addEventListener("click", () => {
		result.replaceChildren(line("info", "Testing connection…"));
		// Give the debounced global-settings save a moment to reach the plugin.
		setTimeout(() => streamDeckClient.send("sendToPlugin", { event: "testConnection" }), 400);
	});

	streamDeckClient.sendToPropertyInspector.subscribe((ev) => {
		const payload = ev.payload || {};
		if (payload.event !== "testConnectionResult") return;
		const steps = Array.isArray(payload.steps) ? payload.steps : [];
		result.replaceChildren(...steps.map((s) => line(s.status, s.text)));
	});

	function line(status, text) {
		const div = document.createElement("div");
		div.className = "step " + status;
		div.textContent = (ICONS[status] || "") + " " + text; // textContent: never interpret server text as HTML
		return div;
	}
})();
