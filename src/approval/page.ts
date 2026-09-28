/**
 * Approval page served by {@link ApprovalServer}. Static HTML; all run data is fetched from the local
 * API and inserted with textContent only (never as HTML), because commands come from the agent.
 */
export const APPROVAL_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Hermes – Approval</title>
<style>
:root { --bg:#f6f7f9; --card:#ffffff; --fg:#1b1f24; --muted:#5b6470; --border:#d8dde3; --code:#f0f2f5;
  --warn:#b45309; --ok:#15803d; --danger:#b91c1c; --btn:#e8ebef; --btn-fg:#1b1f24; }
@media (prefers-color-scheme: dark) { :root { --bg:#15181c; --card:#1e2227; --fg:#e6e8eb; --muted:#9aa3ad; --border:#2e343b;
  --code:#12151a; --warn:#f59e0b; --ok:#4ade80; --danger:#f87171; --btn:#2a3037; --btn-fg:#e6e8eb; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 "Segoe UI", system-ui, sans-serif; }
main { max-width:760px; margin:32px auto; padding:0 16px; }
.card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:20px 22px; }
h1 { font-size:20px; margin:0 0 4px; }
.meta { color:var(--muted); font-size:13px; margin-bottom:16px; word-break:break-all; }
.badge { display:inline-block; font-size:12px; font-weight:600; padding:2px 8px; border-radius:99px; border:1px solid currentColor; color:var(--warn); }
.label { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:16px 0 4px; }
.desc { font-weight:600; }
pre { background:var(--code); border:1px solid var(--border); border-radius:8px; padding:12px; margin:0;
  white-space:pre-wrap; word-break:break-all; font:13px/1.45 Consolas, "Cascadia Mono", monospace; max-height:50vh; overflow:auto; }
.actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:20px; }
button { font:inherit; font-weight:600; padding:9px 14px; border-radius:8px; border:1px solid var(--border);
  background:var(--btn); color:var(--btn-fg); cursor:pointer; }
button.deny { border-color:var(--danger); color:var(--danger); }
button.once { border-color:var(--ok); color:var(--ok); }
button:disabled { opacity:.5; cursor:default; }
.status { margin-top:16px; font-weight:600; min-height:1.5em; }
.status.ok { color:var(--ok); } .status.err { color:var(--danger); }
.hint { color:var(--muted); font-size:13px; margin-top:12px; }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Hermes – Approval</h1>
    <div class="meta" id="meta">Loading…</div>
    <div id="pending" hidden>
      <span class="badge" id="waiting">waiting</span>
      <div class="label">Reason</div>
      <div class="desc" id="desc"></div>
      <div class="label">Command (redacted by Hermes)</div>
      <pre id="command"></pre>
      <div class="actions" id="actions"></div>
      <p class="hint">"Allow for this session" also covers further commands of the same kind in this run. "Always allow" adds the pattern to Hermes' permanent allowlist.</p>
    </div>
    <div class="status" id="status"></div>
  </div>
</main>
<script>
(function () {
  "use strict";
  var token = new URLSearchParams(location.search).get("t") || "";
  var keyId = decodeURIComponent(location.pathname.split("/")[2] || "");
  var api = "/api/" + encodeURIComponent(keyId);
  var LABELS = { once: "Allow once", session: "Allow for this session", always: "Always allow", deny: "Deny" };
  var ORDER = ["deny", "once", "session", "always"];
  var current = null, answered = false, busy = false;

  function $(id) { return document.getElementById(id); }
  function setStatus(text, cls) { var s = $("status"); s.textContent = text; s.className = "status " + (cls || ""); }
  function fmt(ms) { var t = Math.max(0, Math.floor(ms / 1000)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); }

  function render(view) {
    $("meta").textContent = "Key: " + view.keyName + (view.runId ? "  ·  Run " + view.runId : "");
    var a = view.approval;
    if (!a) {
      $("pending").hidden = true;
      if (!answered) setStatus(view.runId ? "No pending approval (answered, timed out or run finished)." : "No run on this key.", "");
      current = null;
      return;
    }
    var same = current && current.requestId === a.requestId && current.command === a.command;
    current = a;
    $("pending").hidden = false;
    if (same) return;
    answered = false;
    setStatus("", "");
    $("desc").textContent = a.description || "(no description)";
    $("command").textContent = a.command || "(no command provided)";
    var box = $("actions");
    box.replaceChildren();
    ORDER.forEach(function (choice) {
      if (a.choices.indexOf(choice) < 0) return;
      var b = document.createElement("button");
      b.className = choice;
      b.textContent = LABELS[choice];
      b.addEventListener("click", function () { answer(choice); });
      box.appendChild(b);
    });
  }

  function tick() {
    if (current && current.requestedAt) $("waiting").textContent = "waiting for " + fmt(Date.now() - current.requestedAt);
  }

  function request(method, body) {
    return fetch(api, {
      method: method,
      headers: body ? { "X-Approval-Token": token, "Content-Type": "application/json" } : { "X-Approval-Token": token },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }

  function refresh() {
    if (busy) return;
    request("GET").then(function (r) {
      if (r.status === 403) { setStatus("Link invalid (Stream Deck restarted?). Please open it again from the key.", "err"); return; }
      render(r.body);
    }).catch(function () { setStatus("Stream Deck not reachable.", "err"); });
  }

  function answer(choice) {
    if (!current || busy) return;
    if (choice === "always" && !confirm("Allow this pattern permanently?\\n\\n" + current.description)) return;
    busy = true;
    Array.prototype.forEach.call(document.querySelectorAll("#actions button"), function (b) { b.disabled = true; });
    setStatus("Sending…", "");
    request("POST", { requestId: current.requestId || "", choice: choice }).then(function (r) {
      busy = false;
      var o = r.body && r.body.outcome;
      if (o === "answered") {
        answered = true;
        setStatus(choice === "deny" ? "Denied. You can close this window." : "Allowed (" + LABELS[choice] + "). You can close this window.", "ok");
      } else if (o === "not_pending") {
        setStatus("This approval is no longer pending (answered elsewhere or timed out).", "err");
      } else if (o === "not_allowed") {
        setStatus("Hermes does not offer this answer for this request.", "err");
      } else {
        setStatus("Could not send the answer – check the connection to Hermes.", "err");
      }
      current = null;
      render(r.body);
    }).catch(function () { busy = false; setStatus("Could not send the answer.", "err"); });
  }

  refresh();
  setInterval(refresh, 1500);
  setInterval(tick, 1000);
})();
</script>
</body>
</html>`;
