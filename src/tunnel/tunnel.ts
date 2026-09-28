import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TunnelConfig = {
	/** Host or ~/.ssh/config alias, optionally user@host. */
	sshHost: string;
	localPort: number;
	remoteHost: string;
	remotePort: number;
};

export type TunnelState =
	| "off"
	| "connecting" // ssh started, local port not up yet
	| "connected" // our tunnel is up and Hermes answers
	| "no_hermes" // our tunnel is up but Hermes does not answer
	| "external" // the local port is served by something we did not start
	| "error"; // ssh exited or the configuration is invalid

export type TunnelStatus = {
	state: TunnelState;
	/** Short reason for `error` / hint for `external`. */
	detail?: string;
	/** Whether Hermes answered through an external tunnel. */
	hermesOk?: boolean;
};

export const DEFAULT_TUNNEL: Omit<TunnelConfig, "sshHost"> = {
	localPort: 8642,
	remoteHost: "127.0.0.1",
	remotePort: 8642,
};

const HOST_PATTERN = /^(?!-)[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/;

/**
 * Validates user input before it ends up on the ssh command line. Returns an error text or undefined.
 * Hosts must not start with "-" so they can never be parsed as ssh options.
 */
export function validateConfig(config: TunnelConfig): string | undefined {
	if (!config.sshHost) return "SSH host missing";
	if (!HOST_PATTERN.test(config.sshHost)) return "Invalid SSH host";
	if (!/^(?!-)[A-Za-z0-9.:_-]+$/.test(config.remoteHost)) return "Invalid target host";
	for (const port of [config.localPort, config.remotePort]) {
		if (!Number.isInteger(port) || port < 1 || port > 65535) return "Invalid port";
	}
	return undefined;
}

export function sshArgs(config: TunnelConfig): string[] {
	return [
		"-N",
		"-o", "BatchMode=yes", // never wait for a password/passphrase prompt nobody can see
		"-o", "ExitOnForwardFailure=yes",
		"-o", "ServerAliveInterval=30",
		"-o", "ServerAliveCountMax=3",
		"-L", `127.0.0.1:${config.localPort}:${config.remoteHost}:${config.remotePort}`,
		"--",
		config.sshHost,
	];
}

/** Maps the last ssh stderr output to a short key text. */
export function describeSshFailure(stderr: string, exitCode: number | null): string {
	const s = stderr.toLowerCase();
	if (s.includes("permission denied")) return "Access denied";
	if (s.includes("could not resolve") || s.includes("name or service not known")) return "Unknown host";
	if (s.includes("connection refused")) return "SSH refused";
	if (s.includes("timed out")) return "Timed out";
	if (s.includes("host key verification failed")) return "Check host key";
	if (s.includes("address already in use") || s.includes("cannot listen")) return "Port in use";
	if (s.includes("administratively prohibited")) return "Forward denied";
	if (s.includes("enoent") || s.includes("not found")) return "ssh not found";
	return exitCode === null ? "SSH exited" : `SSH error ${exitCode}`;
}

export type TunnelDeps = {
	spawn: (command: string, args: string[]) => ChildProcess;
	isPortOpen: (port: number) => Promise<boolean>;
	hermesHealthy: (port: number) => Promise<boolean>;
	/** True if the pid belongs to a running ssh process. */
	isSshProcess: (pid: number) => Promise<boolean>;
	kill: (pid: number) => void;
	pidFile: { read: (port: number) => number | undefined; write: (port: number, pid: number) => void; clear: (port: number) => void };
	sshCommand: () => string;
	log: (message: string) => void;
};

export type TunnelTiming = {
	/** How long to wait for the local port after starting ssh. */
	connectTimeoutMs: number;
	pollMs: number;
	/** Interval for health checks while idle/connected. */
	monitorMs: number;
};

const DEFAULT_TIMING: TunnelTiming = { connectTimeoutMs: 15_000, pollMs: 500, monitorMs: 10_000 };

/**
 * Starts, supervises and stops one `ssh -N -L` process. Only a tunnel started by this plugin (or
 * adopted from a previous plugin run via its pid file) can be stopped; a port served by anything
 * else is reported as `external` and left alone.
 */
export class TunnelController {
	#config: TunnelConfig | undefined;
	#status: TunnelStatus = { state: "off" };
	#child: ChildProcess | undefined;
	/** Pid of an ssh process started by an earlier plugin instance. */
	#adoptedPid: number | undefined;
	#stopping = false;
	#monitor: ReturnType<typeof setInterval> | undefined;
	#busy = false;
	readonly #listeners = new Set<(status: TunnelStatus) => void>();
	readonly #deps: TunnelDeps;
	readonly #timing: TunnelTiming;

	constructor(deps: TunnelDeps, timing: Partial<TunnelTiming> = {}) {
		this.#deps = deps;
		this.#timing = { ...DEFAULT_TIMING, ...timing };
	}

	get status(): TunnelStatus {
		return this.#status;
	}

	get config(): TunnelConfig | undefined {
		return this.#config;
	}

	/** True while a tunnel process belongs to us. */
	get owned(): boolean {
		return this.#child !== undefined || this.#adoptedPid !== undefined;
	}

	onChange(listener: (status: TunnelStatus) => void): void {
		this.#listeners.add(listener);
	}

	/** Applies a (possibly changed) configuration and refreshes the status. */
	async configure(config: TunnelConfig): Promise<void> {
		const changed = JSON.stringify(config) !== JSON.stringify(this.#config);
		if (changed && this.owned && this.#config) {
			this.#deps.log("tunnel configuration changed; stopping the running tunnel");
			await this.stop();
		}
		this.#config = config;
		if (changed) await this.#adopt();
		await this.refresh();
		this.#startMonitor();
	}

	/** Press handler: start when off/failed, stop when ours. Returns what happened. */
	async toggle(): Promise<"started" | "stopped" | "external" | "invalid" | "busy"> {
		if (this.#busy) return "busy";
		if (this.owned) {
			await this.stop();
			return "stopped";
		}
		return this.start();
	}

	async start(): Promise<"started" | "external" | "invalid" | "busy"> {
		const config = this.#config;
		const invalid = config ? validateConfig(config) : "SSH host missing";
		if (!config || invalid) {
			this.#set({ state: "error", detail: invalid });
			return "invalid";
		}
		if (this.#busy) return "busy";
		this.#busy = true;
		try {
			if (await this.#deps.isPortOpen(config.localPort)) {
				await this.refresh();
				return "external";
			}

			this.#stopping = false;
			this.#set({ state: "connecting" });
			let stderr = "";
			const child = this.#deps.spawn(this.#deps.sshCommand(), sshArgs(config));
			this.#child = child;
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr = (stderr + chunk.toString()).slice(-2_000);
			});
			child.once("error", (err) => {
				stderr += ` ${String(err)}`;
			});
			child.once("close", (code) => {
				if (this.#child !== child) return;
				this.#child = undefined;
				this.#deps.pidFile.clear(config.localPort);
				if (this.#stopping) {
					this.#set({ state: "off" });
				} else {
					const detail = describeSshFailure(stderr, code);
					this.#deps.log(`tunnel ssh exited (code ${code}): ${detail}`);
					this.#set({ state: "error", detail });
				}
			});
			if (child.pid !== undefined) this.#deps.pidFile.write(config.localPort, child.pid);
			this.#deps.log(`tunnel starting to ${config.sshHost} (local port ${config.localPort})`);

			const until = Date.now() + this.#timing.connectTimeoutMs;
			while (this.#child === child && Date.now() < until) {
				if (await this.#deps.isPortOpen(config.localPort)) break;
				await sleep(this.#timing.pollMs);
			}
			if (this.#child !== child) return "started"; // ssh already exited; status says why
			if (!(await this.#deps.isPortOpen(config.localPort))) {
				this.#deps.log("tunnel did not come up in time");
				await this.stop();
				this.#set({ state: "error", detail: "No connection" });
				return "started";
			}
			const healthy = await this.#deps.hermesHealthy(config.localPort);
			if (this.#child === child) this.#set({ state: healthy ? "connected" : "no_hermes" });
			return "started";
		} finally {
			this.#busy = false;
		}
	}

	async stop(): Promise<void> {
		const config = this.#config;
		this.#stopping = true;
		if (this.#child?.pid !== undefined) {
			this.#deps.kill(this.#child.pid);
		} else if (this.#adoptedPid !== undefined) {
			this.#deps.kill(this.#adoptedPid);
			this.#adoptedPid = undefined;
			if (config) this.#deps.pidFile.clear(config.localPort);
			this.#set({ state: "off" });
		}
		if (config) this.#deps.log("tunnel stopped");
	}

	/** Re-evaluates the state from the port and Hermes health. */
	async refresh(): Promise<void> {
		const config = this.#config;
		if (!config) return;
		if (this.#status.state === "connecting" && this.#child) return;

		const invalid = validateConfig(config);
		if (invalid && !this.owned) {
			this.#set({ state: "off", detail: invalid });
			return;
		}

		const portOpen = await this.#deps.isPortOpen(config.localPort);
		if (this.owned) {
			if (!portOpen) {
				if (this.#adoptedPid !== undefined && !(await this.#deps.isSshProcess(this.#adoptedPid))) {
					this.#adoptedPid = undefined;
					this.#deps.pidFile.clear(config.localPort);
					this.#set({ state: "off" });
				}
				return; // our ssh is alive but the forward is not listening (yet); close handler reports exits
			}
			const healthy = await this.#deps.hermesHealthy(config.localPort);
			this.#set({ state: healthy ? "connected" : "no_hermes" });
			return;
		}
		if (portOpen) {
			const healthy = await this.#deps.hermesHealthy(config.localPort);
			this.#set({ state: "external", hermesOk: healthy, detail: healthy ? "Hermes OK" : "Port in use" });
			return;
		}
		if (this.#status.state === "error") return; // keep the last failure visible until the next press
		this.#set({ state: "off" });
	}

	dispose(): void {
		clearInterval(this.#monitor);
		if (this.#child?.pid !== undefined) {
			this.#stopping = true;
			this.#deps.kill(this.#child.pid);
		}
	}

	async #adopt(): Promise<void> {
		const config = this.#config;
		if (!config || this.#child) return;
		const pid = this.#deps.pidFile.read(config.localPort);
		if (pid === undefined) return;
		if (await this.#deps.isSshProcess(pid)) {
			this.#adoptedPid = pid;
			this.#deps.log(`adopted tunnel ssh process from a previous plugin run (pid ${pid})`);
		} else {
			this.#deps.pidFile.clear(config.localPort);
		}
	}

	#startMonitor(): void {
		if (this.#monitor) return;
		this.#monitor = setInterval(() => void this.refresh().catch(() => {}), this.#timing.monitorMs);
	}

	#set(status: TunnelStatus): void {
		const same = status.state === this.#status.state && status.detail === this.#status.detail && status.hermesOk === this.#status.hermesOk;
		this.#status = status;
		if (!same) for (const listener of this.#listeners) listener(status);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Real implementations of {@link TunnelDeps} for the plugin runtime.
 */
export function systemTunnelDeps(log: (message: string) => void): TunnelDeps {
	const pidPath = (port: number) => join(tmpdir(), `hermes-streamdeck-tunnel-${port}.pid`);
	return {
		spawn: (command, args) => spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, shell: false }),
		isPortOpen: (port) =>
			new Promise((resolve) => {
				const socket = connect({ host: "127.0.0.1", port });
				const done = (open: boolean) => {
					socket.destroy();
					resolve(open);
				};
				socket.setTimeout(1_000, () => done(false));
				socket.once("connect", () => done(true));
				socket.once("error", () => done(false));
			}),
		hermesHealthy: async (port) => {
			try {
				const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3_000) });
				return res.ok;
			} catch {
				return false;
			}
		},
		isSshProcess: (pid) =>
			new Promise((resolve) => {
				if (process.platform === "win32") {
					execFile("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true }, (err, stdout) => {
						resolve(!err && /^"ssh\.exe"/im.test(stdout));
					});
				} else {
					execFile("ps", ["-p", String(pid), "-o", "comm="], (err, stdout) => resolve(!err && /(^|\/)ssh$/m.test(stdout.trim())));
				}
			}),
		kill: (pid) => {
			try {
				process.kill(pid);
			} catch (err) {
				log(`killing tunnel pid ${pid} failed: ${String(err)}`);
			}
		},
		pidFile: {
			read: (port) => {
				try {
					const pid = Number.parseInt(readFileSync(pidPath(port), "utf8"), 10);
					return Number.isInteger(pid) && pid > 0 ? pid : undefined;
				} catch {
					return undefined;
				}
			},
			write: (port, pid) => {
				try {
					writeFileSync(pidPath(port), String(pid));
				} catch (err) {
					log(`writing tunnel pid file failed: ${String(err)}`);
				}
			},
			clear: (port) => rmSync(pidPath(port), { force: true }),
		},
		sshCommand: () => {
			if (process.platform === "win32") {
				const builtIn = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
				if (existsSync(builtIn)) return builtIn;
			}
			return "ssh";
		},
		log,
	};
}
