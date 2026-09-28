import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";

import { tunnelConfigFrom } from "../src/app";
import { describeSshFailure, sshArgs, TunnelController, type TunnelConfig, type TunnelDeps, validateConfig } from "../src/tunnel/tunnel";

const CONFIG: TunnelConfig = { sshHost: "hermes-tunnel", localPort: 8642, remoteHost: "127.0.0.1", remotePort: 8642 };

class FakeChild extends EventEmitter {
	stderr = new EventEmitter();
	constructor(readonly pid: number) {
		super();
	}
	exit(code: number | null, stderr = "") {
		if (stderr) this.stderr.emit("data", Buffer.from(stderr));
		this.emit("close", code);
	}
}

function setup() {
	const state = {
		portOpen: false,
		healthy: true,
		sshPids: new Set<number>(),
		pidFile: new Map<number, number>(),
		spawned: [] as { command: string; args: string[]; child: FakeChild }[],
		killed: [] as number[],
		/** What a spawned ssh does: "listen" opens the port, "fail" exits with stderr. */
		behaviour: "listen" as "listen" | "fail" | "hang",
		failText: "",
	};
	let nextPid = 100;
	const deps: TunnelDeps = {
		spawn: (command, args) => {
			const child = new FakeChild(nextPid++);
			state.spawned.push({ command, args, child });
			state.sshPids.add(child.pid);
			setTimeout(() => {
				if (state.behaviour === "listen") state.portOpen = true;
				if (state.behaviour === "fail") child.exit(255, state.failText);
			}, 2);
			return child as unknown as ChildProcess;
		},
		isPortOpen: async () => state.portOpen,
		hermesHealthy: async () => state.healthy,
		isSshProcess: async (pid) => state.sshPids.has(pid),
		kill: (pid) => {
			state.killed.push(pid);
			state.sshPids.delete(pid);
			state.portOpen = false;
			state.spawned.find((s) => s.child.pid === pid)?.child.exit(null);
		},
		pidFile: {
			read: (port) => state.pidFile.get(port),
			write: (port, pid) => state.pidFile.set(port, pid),
			clear: (port) => state.pidFile.delete(port),
		},
		sshCommand: () => "ssh",
		log: () => {},
	};
	const tunnel = new TunnelController(deps, { connectTimeoutMs: 100, pollMs: 2, monitorMs: 60_000 });
	return { tunnel, state };
}

describe("tunnel configuration", () => {
	it("builds ssh arguments with host after --, bound to localhost", () => {
		expect(sshArgs(CONFIG)).toEqual([
			"-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
			"-L", "127.0.0.1:8642:127.0.0.1:8642", "--", "hermes-tunnel",
		]);
	});

	it("rejects hosts that could be parsed as options or contain shell characters", () => {
		expect(validateConfig(CONFIG)).toBeUndefined();
		expect(validateConfig({ ...CONFIG, sshHost: "user@host.example" })).toBeUndefined();
		expect(validateConfig({ ...CONFIG, sshHost: "" })).toBe("SSH host missing");
		expect(validateConfig({ ...CONFIG, sshHost: "-oProxyCommand=calc" })).toBe("Invalid SSH host");
		expect(validateConfig({ ...CONFIG, sshHost: "host; rm -rf" })).toBe("Invalid SSH host");
		expect(validateConfig({ ...CONFIG, remoteHost: "-x" })).toBe("Invalid target host");
		expect(validateConfig({ ...CONFIG, localPort: 0 })).toBe("Invalid port");
		expect(validateConfig({ ...CONFIG, remotePort: Number.NaN })).toBe("Invalid port");
	});

	it("reads global settings with defaults", () => {
		expect(tunnelConfigFrom({ tunnelHost: " hermes-tunnel " })).toEqual(CONFIG);
		expect(tunnelConfigFrom({ tunnelHost: "h", tunnelLocalPort: "9000", tunnelRemotePort: "8000", tunnelRemoteHost: "10.0.0.1" })).toEqual({
			sshHost: "h", localPort: 9000, remoteHost: "10.0.0.1", remotePort: 8000,
		});
		expect(tunnelConfigFrom({ tunnelLocalPort: "abc" }).localPort).toBeNaN();
	});

	it("maps common ssh failures to short texts", () => {
		expect(describeSshFailure("streamdeck@host: Permission denied (publickey).", 255)).toBe("Access denied");
		expect(describeSshFailure("ssh: Could not resolve hostname x", 255)).toBe("Unknown host");
		expect(describeSshFailure("bind [127.0.0.1]:8642: Address already in use", 255)).toBe("Port in use");
		expect(describeSshFailure("Host key verification failed.", 255)).toBe("Check host key");
		expect(describeSshFailure("", 1)).toBe("SSH error 1");
	});
});

describe("TunnelController", () => {
	it("starts ssh, waits for the port and reports connected; a second press stops it", async () => {
		const { tunnel, state } = setup();
		await tunnel.configure(CONFIG);
		expect(tunnel.status.state).toBe("off");

		expect(await tunnel.toggle()).toBe("started");
		expect(tunnel.status.state).toBe("connected");
		expect(state.spawned[0]!.args.at(-1)).toBe("hermes-tunnel");
		expect(state.pidFile.get(8642)).toBe(100);

		expect(await tunnel.toggle()).toBe("stopped");
		expect(state.killed).toEqual([100]);
		expect(tunnel.status.state).toBe("off");
		expect(state.pidFile.has(8642)).toBe(false);
		tunnel.dispose();
	});

	it("reports no_hermes when the tunnel is up but Hermes does not answer", async () => {
		const { tunnel, state } = setup();
		state.healthy = false;
		await tunnel.configure(CONFIG);
		await tunnel.toggle();
		expect(tunnel.status.state).toBe("no_hermes");
		tunnel.dispose();
	});

	it("shows why ssh failed", async () => {
		const { tunnel, state } = setup();
		state.behaviour = "fail";
		state.failText = "streamdeck@host: Permission denied (publickey).";
		await tunnel.configure(CONFIG);
		await tunnel.toggle();
		expect(tunnel.status).toEqual({ state: "error", detail: "Access denied" });
		expect(tunnel.owned).toBe(false);
		tunnel.dispose();
	});

	it("gives up and kills ssh when the port never opens", async () => {
		const { tunnel, state } = setup();
		state.behaviour = "hang";
		await tunnel.configure(CONFIG);
		await tunnel.toggle();
		expect(tunnel.status).toEqual({ state: "error", detail: "No connection" });
		expect(state.killed).toEqual([100]);
		tunnel.dispose();
	});

	it("leaves an external tunnel alone", async () => {
		const { tunnel, state } = setup();
		state.portOpen = true;
		await tunnel.configure(CONFIG);
		expect(tunnel.status).toEqual({ state: "external", hermesOk: true, detail: "Hermes OK" });
		expect(await tunnel.toggle()).toBe("external");
		expect(state.spawned).toHaveLength(0);
		expect(state.killed).toHaveLength(0);
		tunnel.dispose();
	});

	it("adopts its own ssh from a previous plugin run and can stop it", async () => {
		const { tunnel, state } = setup();
		state.portOpen = true;
		state.sshPids.add(4242);
		state.pidFile.set(8642, 4242);
		await tunnel.configure(CONFIG);
		expect(tunnel.status.state).toBe("connected");
		expect(tunnel.owned).toBe(true);

		expect(await tunnel.toggle()).toBe("stopped");
		expect(state.killed).toEqual([4242]);
		expect(tunnel.status.state).toBe("off");
		tunnel.dispose();
	});

	it("ignores a stale pid file whose process is gone", async () => {
		const { tunnel, state } = setup();
		state.pidFile.set(8642, 4242);
		await tunnel.configure(CONFIG);
		expect(tunnel.owned).toBe(false);
		expect(state.pidFile.has(8642)).toBe(false);
		tunnel.dispose();
	});

	it("refuses to start with an invalid configuration", async () => {
		const { tunnel, state } = setup();
		await tunnel.configure({ ...CONFIG, sshHost: "" });
		expect(await tunnel.toggle()).toBe("invalid");
		expect(tunnel.status).toEqual({ state: "error", detail: "SSH host missing" });
		expect(state.spawned).toHaveLength(0);
		tunnel.dispose();
	});

	it("reports an unexpected ssh exit while connected", async () => {
		const { tunnel, state } = setup();
		await tunnel.configure(CONFIG);
		await tunnel.toggle();
		state.portOpen = false;
		state.spawned[0]!.child.exit(255, "Connection to host closed by remote host.");
		expect(tunnel.status.state).toBe("error");
		expect(tunnel.owned).toBe(false);
		tunnel.dispose();
	});
});
