# Architecture

The plugin is split into three layers. Only the lowest layer knows Hermes' HTTP API.

```
src/
├── hermes/        Hermes client — HTTP, auth, SSE, timeouts, error mapping
│   ├── client.ts
│   ├── sse.ts
│   ├── errors.ts
│   └── types.ts
├── runs/          Run management — state machine, tracking, restore
│   ├── state.ts
│   ├── tracker.ts
│   └── manager.ts
├── actions/       Stream Deck actions — key presses, rendering, property inspector messages
│   ├── start-run.ts
│   ├── stop-run.ts
│   └── tunnel.ts
├── prompt/        placeholder resolution ({{clipboard}}, {{input}}, …)
│   └── template.ts
├── results/       Markdown result files + retention
│   └── store.ts
├── system/        desktop integration (clipboard, input dialog, open file)
│   └── desktop.ts
├── approval/      local approval page (HTTP server on 127.0.0.1)
│   ├── server.ts
│   └── page.ts
├── tunnel/        SSH tunnel process control
│   └── tunnel.ts
├── ui/render.ts   SVG key images per state
├── connection.ts  current client + periodic health/auth check
├── app.ts         wiring shared by both actions
└── plugin.ts      entry point
```

## Hermes client (`src/hermes`)

`HermesClient` wraps the endpoints the plugin uses:

| Method | Endpoint |
|---|---|
| `health()` | `GET /health` (no auth) |
| `capabilities()` | `GET /v1/capabilities` — also used as the API key check |
| `startRun()` | `POST /v1/runs` with `Idempotency-Key` |
| `getRun()` | `GET /v1/runs/{id}` |
| `stopRun()` | `POST /v1/runs/{id}/stop` |
| `streamEvents()` | `GET /v1/runs/{id}/events` (SSE, `Last-Event-ID` resume) |

All failures become a `HermesError` with a `kind` (`unreachable`, `timeout`, `auth`, `not_found`, `conflict`, `rate_limited`, …). Error messages never include the API key or request bodies.

Hermes-specific details verified against Hermes 0.21.5:

- The SSE event name is in the JSON payload (`{"event": "run.completed", …}`), not in an SSE `event:` line. Each event has an `id:` (the server's `seq`).
- Comment lines (`: open`, `: keepalive`, `: stream closed`) are ignored; a keepalive arrives every ~10 s, so a stream silent for 35 s is treated as dead.
- For a finished run the stream replays the buffered events and closes; `Last-Event-ID: n` resumes after event `n`.
- Unknown event names (e.g. `reasoning.available`) are harmless: any non-terminal event just means "still running".

## Run management (`src/runs`)

`state.ts` is a pure state machine: server statuses and events map to a `RunPhase` (`idle`, `checking`, `starting`, `running`, `approval`, `stopping`, `completed`, `cancelled`, `failed`, `interrupted`, `lost`, `start_failed`). Unknown statuses map to `running`, never to a success state. A locally requested stop stays `stopping` until a terminal status arrives.

`RunTracker` follows one run until it is terminal:

1. reconcile with `GET /v1/runs/{id}`,
2. follow the SSE stream, resuming from the last seen event id,
3. when the stream ends or fails without a terminal event → back to 1 (with backoff on errors),
4. if the stream endpoint returns 404 (Hermes dropped the event buffer) → poll the status instead,
5. if the status endpoint returns 404 → `lost`.

While Hermes is unreachable the phase is kept and flagged `reconnecting`, so a key never jumps to a made-up final state.

`RunManager` owns one run per Start Run key (keyed by Stream Deck action id):

- `start()` sets `starting` synchronously, so a second press is refused as `busy` before any network call; a transient failure is retried once with the same idempotency key.
- `stop()` sends the stop and marks `stopping`; the tracker reports `cancelled` once Hermes confirms.
- `restore()` is called when a key appears after a (re)start: persisted terminal states are shown as they were; active runs are re-checked (`checking` → real status or `lost`).
- Runs are persisted into the key's action settings as `{ runId, phase, startedAt, endedAt }` — no secrets, no output.

## Stream Deck layer (`src/actions`, `src/ui`)

- **StartRunAction** reads prompt/model from its action settings, calls `RunManager.start()`, renders the key image on every change and ticks the elapsed time once per second. A press on a finished run only acknowledges it (`RunManager.reset()`).
- **StopRunAction** resolves its target (explicit Start key or the last started one), calls `RunManager.stop()` and shows the target's name and state; if the target run already ended, a press acknowledges it instead.
- Key images are SVG data URLs generated in `ui/render.ts`; the user's Stream Deck title is drawn on top by the app.
- The property inspectors (`*.sdPlugin/ui/*.html`) use `sdpi-components` v4, bundled locally. URL and API key are bound with the `global` attribute → plugin global settings; prompt/model/target are action settings. "Test connection" and the Stop target list use `sendToPlugin` / `sendToPropertyInspector` messages.
- Logging runs at `info`; `trace` would log Stream Deck messages including global settings.

## Tunnel (`src/tunnel`)

`TunnelController` owns at most one `ssh -N -L` child process, configured from the plugin's global settings (`tunnelHost`, ports). It never uses a shell; the host is validated and passed after `--`.

- **start**: if the local port is already open, the tunnel is `external` and left alone. Otherwise spawn ssh, write its pid to `<tmp>/hermes-streamdeck-tunnel-<port>.pid`, poll the port (15 s), then check `/health` → `connected` or `no_hermes`. If ssh exits, stderr is mapped to a short reason (`error`).
- **stop**: kill our child (or an adopted pid).
- **adopt**: on (re)configuration a pid file pointing to a live `ssh` process makes that process "ours" again, so a tunnel orphaned by a hard plugin kill can still be stopped.
- A 10 s monitor refreshes the state; every tunnel change triggers a Hermes connection check so Start keys switch between *Offline* and *Ready*.

## Approvals (`src/approval`, `runs`)

Verified against Hermes 0.21.5:

- `approval.request` (SSE) and the `approval` field of `GET /v1/runs/{id}` carry `command` (redacted by Hermes), `description`, `request_id`, `choices` (`once`, `session`, `always`, `deny` — fewer after a smart-deny) and `timestamp`.
- Answers go to `POST /v1/runs/{id}/approval` as `{"choice": …, "request_id": …}`. The documented `decision` field is rejected (400). A second answer gets `409 approval_not_pending`. Hermes then emits `approval.responded`.
- After a deny the run usually still ends as `completed`; the tracker records `denied` so the key can say so.

`RunTracker` keeps the pending approval (from events and reconciles) and clears it on `approval.responded`, any non-approval status or a terminal event. `RunManager.respondApproval()` only answers when the given request id equals the pending one and the choice is among the offered ones.

`ApprovalServer` is a tiny `node:http` server bound to `127.0.0.1` on a random port. Requests must carry the per-session token (page: `?t=`; API: `X-Approval-Token` header, which also forces a CORS preflight that is never granted) and a `Host` header of `127.0.0.1:<port>` (DNS-rebinding guard). The page (`page.ts`) is static; it polls `GET /api/<keyId>` and renders all data with `textContent`.

## Prompts and results (`src/prompt`, `src/results`, `src/system`)

- On a Start press, `resolvePrompt()` replaces placeholders in one pass (clipboard read first, then the input dialog). While it runs (dialog open) further presses are refused. Failures end in `start_failed` with a short reason via `RunManager.failBeforeStart()`; a cancelled dialog changes nothing.
- The tracker keeps the final `output` / `error` (from the terminal event, or from `GET /v1/runs/{id}` if the stream missed it). `RunManager` calls `onFinished` once per run tracked in this session; `App` writes the Markdown file (`ResultStore`), stores its path via `attachResult()` (persisted, so it survives a restart) and applies the key's *Result* setting.
- `systemDesktop` uses `execFile` only (no shell): PowerShell with UTF-8 in/out for the clipboard and a WinForms input dialog (the key title is passed via an environment variable), `explorer.exe <file>` to open results, and `[Environment]::GetFolderPath('MyDocuments')` so redirected (e.g. OneDrive) document folders are honoured.
