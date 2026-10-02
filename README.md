# Hermes Streamdeck

[![CI](https://github.com/Mugen0815/hermes-streamdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/Mugen0815/hermes-streamdeck/actions/workflows/ci.yml)

A Stream Deck plugin that starts, monitors and stops [Hermes Agent](https://hermes-agent.nousresearch.com/) runs from a key.

- **Start Run** — starts the prompt configured on the key and shows the run's live state on that key.
- **Stop Run** — stops the run of a selected Start Run key (or the most recently started one).
- **Steer Run** — sends guidance text to that run while it is running (e.g. "focus on the tests").
- **Tunnel** — starts/stops the SSH tunnel to the Hermes API and shows whether Hermes is reachable through it.

It is a remote control for an existing Hermes API server, not a second agent implementation.

> Independent community project — not affiliated with or endorsed by Nous Research or Elgato.
> Status: 0.3, developed and tested on Windows. macOS is declared in the manifest but untested.

## Requirements

| | Version |
|---|---|
| Stream Deck app | 7.1 or newer |
| Hermes Agent | API server enabled (tested with 0.21.5) |
| Node.js (only for building) | 24 or newer |

The Hermes API server must have the run endpoints (`/v1/runs`, status, events, stop). The **Test connection** button checks this via `/v1/capabilities`.

## Connecting to Hermes

Hermes binds its API server to `127.0.0.1:8642` by default. The recommended setup keeps it that way and forwards the port over SSH to the machine the Stream Deck is attached to:

```
Stream Deck PC  localhost:8642  ──ssh -L──▶  Hermes host  127.0.0.1:8642
```

On the Hermes host (example for a dedicated, restricted user):

```bash
sudo useradd --create-home --shell /usr/sbin/nologin streamdeck
sudo install -d -m 700 -o streamdeck -g streamdeck /home/streamdeck/.ssh
# one line, with your public key:
echo 'restrict,port-forwarding,permitopen="127.0.0.1:8642",command="/bin/false" ssh-ed25519 AAAA... streamdeck' \
  | sudo tee /home/streamdeck/.ssh/authorized_keys
sudo chown streamdeck:streamdeck /home/streamdeck/.ssh/authorized_keys
sudo chmod 600 /home/streamdeck/.ssh/authorized_keys
```

That key can only open a tunnel to the Hermes port — no shell, no other ports.

On the Stream Deck PC, add to `~/.ssh/config`:

```
Host hermes-tunnel
    HostName your-hermes-host
    User streamdeck
    IdentityFile ~/.ssh/id_ed25519_streamdeck
    IdentitiesOnly yes
    ExitOnForwardFailure yes
    ServerAliveInterval 30
    ServerAliveCountMax 3
```

Then either put a **Tunnel** key on your Stream Deck (below) or start the tunnel yourself:

```bash
ssh -N -L 8642:127.0.0.1:8642 hermes-tunnel
```

If the tunnel is down, Start Run keys show **Offline**.

### Tunnel key

In the Tunnel key's settings enter the **SSH host** (e.g. the alias `hermes-tunnel`) and, if different from 8642, the ports. A press starts `ssh -N -L 127.0.0.1:<local>:<target-host>:<target-port> -- <host>` (with `BatchMode=yes`, `ExitOnForwardFailure=yes` and keepalives); another press stops it.

| Tunnel key | Meaning |
|---|---|
| Tunnel off | not running (press to start) |
| Connecting… | ssh started, waiting for the local port |
| Connected | tunnel up, Hermes answers `/health` |
| Hermes down | tunnel up, but Hermes does not answer |
| External | the local port is served by something the plugin did not start (e.g. a manual ssh); the key will not stop it |
| Tunnel error | ssh ended — short reason below (e.g. *Access denied*, *Unknown host*, *Port in use*) |

Notes:
- Login must work non-interactively (SSH key without passphrase prompt, host key already in `known_hosts`). On Windows the built-in OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`) is used, which reads `%USERPROFILE%\.ssh\config`.
- The tunnel ends when the Stream Deck app quits. If the plugin is killed hard, the next start finds its ssh process again via a pid file in the temp directory and can stop it.
- The SSH host is validated (no leading `-`, no spaces or shell characters) and ssh is started without a shell.

## Installation

Download the `.streamDeckPlugin` file from the [latest release](https://github.com/Mugen0815/hermes-streamdeck/releases/latest) and double-click it; Stream Deck installs the plugin.

## Installation (from source)

```bash
git clone https://github.com/Mugen0815/hermes-streamdeck.git
cd hermes-streamdeck
npm install
npm run build
npx streamdeck link io.github.mugen0815.hermes-streamdeck.sdPlugin
```

Restart the Stream Deck app once; the actions appear in the category **Hermes Streamdeck**.

For development, `npm run watch` rebuilds and restarts the plugin on changes. `npm test` runs the unit tests.
Restarting a single plugin (`streamdeck restart`, also used by `watch`) only works with Stream Deck's developer mode enabled (`npx streamdeck dev`); otherwise restart the Stream Deck app to load a new build.

## Configuration

1. Drag **Start Run** onto a key.
2. In the settings panel below (the "property inspector"):
   - **Hermes URL** — default `http://127.0.0.1:8642`
   - **API key** — the `API_SERVER_KEY` of your Hermes API server
   - click **Test connection** — it checks the chain step by step and names the broken link:
     1. SSH tunnel (if a Tunnel key is set up; if no tunnel is open, one is opened just for the test and closed afterwards),
     2. Hermes reachable (with version),
     3. API key valid,
     plus hints such as a Hermes URL port that does not match the tunnel.
3. Enter the **Prompt** for this key (placeholders see below); optionally a **Model** (passed as `model` to Hermes; leave empty for Hermes' default) and what should happen with the **Result** (see below).
4. Set the key title with Stream Deck's normal title field.

URL and API key are shared by all keys of this plugin.

Optionally drag **Stop Run** onto another key and choose which Start Run key it controls. The default, *Most recently started run*, follows whichever Start Run key was pressed last; the Stop key always shows the name of its current target.

## What the keys show

| Start Run key | Meaning |
|---|---|
| Ready ▶ | ready to start |
| Offline / API key? / Set up | Hermes unreachable / key rejected / not configured yet |
| Starting… | start request in flight |
| Running m:ss | run active, with elapsed time |
| Approval? m:ss | Hermes waits for an approval; below: what kind of action (e.g. *delete in root path*). **Press to open the approval page** |
| Stopping… | stop requested, not yet confirmed by Hermes |
| Done ✓ | completed (*denied* below if an approval was denied — the agent then did not do everything asked) |
| Stopped ■ | cancelled |
| Failed ✕ / Start failed ✕ | run failed / could not be started (short reason below) |
| Interrupted | Hermes shut down during the run |
| Unknown ? | the run is no longer known to Hermes; its outcome is unknown |
| *no connection* (small, yellow) | connection lost while a run is active — the state shown may be outdated |

**Pressing Start while its run is active is ignored** (the key flashes a warning). A finished run (Done, Stopped, Failed, …) stays on the key until you **acknowledge it by pressing Start or the Stop key** targeting it; the key then shows *Ready* again and the next press starts a new run. Every start carries an `Idempotency-Key`, so a retried request after a network hiccup cannot start a second run.

The Stop key shows *Stopping…* after the press and *Stopped* only once Hermes reports the run as cancelled. While its target shows a finished run, the Stop key mirrors that result and a press acknowledges it. With no run at all it flashes *No run*.

## Steer Run

Drag **Steer Run** onto a key, choose its target like for Stop Run (a specific Start Run key or *Most recently started run*) and enter the **Text**. The text supports the same placeholders as prompts; `{{input}}` alone asks for free-form guidance on every press.

| Steer Run key | Meaning |
|---|---|
| Steer (purple) | the target run is running — press to send the text |
| No run / Not running (dimmed) | no active run, or the run is waiting for an approval / stopping (Hermes only accepts steer text while a run is running) |
| Queued ✓ | Hermes accepted the text |

Hermes queues steer text and hands it to the agent at its **next tool boundary** — "Queued" means accepted, not processed. Every accepted text is listed with its time under *Steer* in the run's result file. If the run ends before that, the undelivered text is listed under *Steer not delivered* in the result file.

## Prompt placeholders

| Placeholder | Replaced with |
|---|---|
| `{{clipboard}}` | the text in the clipboard. Empty → the run is not started (*Clipboard empty*); more than 50 000 characters → *Clipboard too big*. |
| `{{input}}` | text typed into a small dialog that opens on the key press (Ctrl+Enter = start, Esc = cancel; cancelling starts nothing). |
| `{{date}}`, `{{time}}` | e.g. 2026-09-28, 20:15 |

Example: `Summarize this text in three bullet points: {{clipboard}}`. Names are case-insensitive; text inserted from the clipboard or the dialog is never expanded again. Clipboard and dialog contents are not written to the log. (The German names of early versions — `{{zwischenablage}}`, `{{eingabe}}`, `{{datum}}`, `{{uhrzeit}}` — still work.)

## Results

Every finished run is saved as a Markdown file in **Documents\Hermes Streamdeck** (`2026-09-28 20-15-42 <key title>.md`) with status, times, run id, the resolved prompt, the steer texts sent to the run and Hermes' answer. Per Start Run key you choose what happens with it:

| Result | Behaviour |
|---|---|
| Open when acknowledged *(default)* | the finished key shows *press for result*; pressing it opens the file (with the app Windows uses for `.md`) and resets the key |
| Open immediately | the file opens as soon as the run ends |
| Copy to clipboard | the answer is copied to the clipboard as soon as the run ends (the key flashes ✓) |
| Save only | only saved |

A Stop key acknowledges a finished run without opening the file. Result files older than **30 days** are deleted automatically (setting *Keep (days)*, `0` = keep forever); only files matching the plugin's own name pattern are ever removed.

## Approvals

When Hermes asks for approval (`approvals.mode: manual` or `smart` in Hermes' config), the Start Run key turns orange: **Approval?**, the waiting time and the kind of action. The key itself never approves anything. A press opens a local page in your browser that shows:

- the full command (as redacted by Hermes), the reason and the run,
- the answers Hermes offers for this request: **Allow once**, **Allow for this session**, **Always allow** (asks for confirmation — it adds the pattern to Hermes' permanent allowlist) and **Deny**.

The answer is bound to the exact Hermes `request_id`; if the request was answered elsewhere or timed out (Hermes' `approvals.timeout`), the page says so instead of answering a different request.

The page is served by the plugin on `127.0.0.1` (random port) and protected by a random per-session token, a Host-header check and a strict Content-Security-Policy; the API requires a custom header, so other web pages cannot trigger answers. After a Stream Deck restart old links stop working — just press the key again.

## Security notes

- The API key is stored in the plugin's **global settings** of the Stream Deck app, not in action settings, so it is not included in exported profiles. On Windows, Stream Deck keeps global settings in the **Windows Credential Manager** (a generic credential named after the plugin UUID; observed with Stream Deck 7.6), not in plain-text files. That protects it at rest and against other Windows users, but **any program running under your Windows account can read it** — treat the machine accordingly. (macOS was not tested.)
- The key is never written to the plugin log. Logs (`<plugin>/logs/`) contain run ids and error categories, not prompts or output.
- Action settings (prompt, model, last run id) are plain text and are part of profile exports. Don't put secrets into prompts.
- Result files contain the full prompt (including inserted clipboard/dialog text) and Hermes' answer and stay on disk until the retention period ends. Keep that in mind for sensitive content.

## Known limits (0.3)

- Hermes' approval timeout is not exposed by the API, so the page shows how long the request has been waiting rather than a countdown.
- **Run history is in memory on the Hermes side.** Hermes keeps a finished run's status for about an hour and forgets all runs when it restarts. After a Stream Deck restart the key re-checks its last run; if Hermes no longer knows it, the key shows *Unknown* instead of guessing.
- Hermes discards a run's event buffer a few minutes after start if nobody listens; the plugin then falls back to polling the status (every 3 s).
- There is no API to list runs, so a run started elsewhere cannot be attached to a key.
- The Stop target list only contains Start Run keys that were visible since Stream Deck started (Stream Deck only reports visible keys). Put Start and Stop keys on the same page for the most reliable behaviour.
- Each key press is a full agent run and consumes tokens accordingly (Hermes sends its complete system prompt, even for tiny prompts).
- Only one Hermes instance per plugin installation.
- macOS: declared but untested; the `{{input}}` dialog is Windows-only.

## Development and releases

- Every pull request and push to `main` runs type check, tests, build and manifest validation on Windows and Ubuntu (`.github/workflows/ci.yml`).
- To release: bump the version in `package.json` (`npm version X.Y.Z --no-git-tag-version`) and `manifest.json` (`X.Y.Z.0`), merge, then push a tag `vX.Y.Z`. The release workflow checks that tag and versions agree, packs the plugin and creates a GitHub release with the `.streamDeckPlugin` file.
- Dependabot opens weekly grouped update PRs for npm packages and GitHub Actions.

## License

MIT — see [LICENSE](LICENSE). `sdpi-components.js` (bundled in `ui/`) is © Corsair Memory Inc. and contributors, MIT licensed.
