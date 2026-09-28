import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Desktop integration used by the Start Run action. Everything goes through execFile (no shell);
 * user data travels via stdin or environment variables, never on a command line.
 */
export type Desktop = {
	readClipboard(): Promise<string>;
	writeClipboard(text: string): Promise<void>;
	/** Opens a file with the application Windows associates with its extension. */
	openFile(path: string): Promise<void>;
	/** Shows a small input dialog; resolves undefined when cancelled. */
	askInput(title: string): Promise<string | undefined>;
	documentsDir(): Promise<string>;
};

const WIN = process.platform === "win32";
const POWERSHELL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

type RunOptions = { input?: string; env?: Record<string, string>; timeoutMs?: number };

function run(command: string, args: string[], options: RunOptions = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			command,
			args,
			{
				windowsHide: true,
				encoding: "utf8",
				maxBuffer: 16 * 1024 * 1024,
				timeout: options.timeoutMs ?? 15_000,
				env: { ...process.env, ...options.env },
			},
			(err, stdout) => (err ? reject(err) : resolve(stdout)),
		);
		if (options.input !== undefined) child.stdin?.end(options.input, "utf8");
		else child.stdin?.end();
	});
}

function powershell(script: string, options: RunOptions = {}): Promise<string> {
	// UTF-8 in both directions; PowerShell 5.1 defaults to the OEM code page otherwise.
	const prelude = "[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;";
	return run(POWERSHELL, [...PS_ARGS, prelude + script], options);
}

/**
 * Multi-line input dialog (WinForms), always on top. Ctrl+Enter submits, Esc cancels.
 * The title comes in via an environment variable so it can never be interpreted as code.
 */
const INPUT_DIALOG = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace HSD -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Hermes – ' + $env:HSD_TITLE
$f.Size = New-Object System.Drawing.Size(560, 300)
$f.StartPosition = 'CenterScreen'
$f.TopMost = $true
$f.MinimizeBox = $false
$f.MaximizeBox = $false
$f.KeyPreview = $true
$l = New-Object System.Windows.Forms.Label
$l.Text = 'Input for the prompt (Ctrl+Enter = start, Esc = cancel):'
$l.SetBounds(12, 10, 520, 20)
$t = New-Object System.Windows.Forms.TextBox
$t.Multiline = $true
$t.AcceptsReturn = $true
$t.ScrollBars = 'Vertical'
$t.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$t.SetBounds(12, 34, 520, 170)
$t.Anchor = 'Top, Left, Right, Bottom'
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Start'
$ok.SetBounds(356, 215, 85, 30)
$ok.Anchor = 'Bottom, Right'
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.SetBounds(447, 215, 85, 30)
$cancel.Anchor = 'Bottom, Right'
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$f.CancelButton = $cancel
$f.Controls.AddRange(@($l, $t, $ok, $cancel))
$f.Add_KeyDown({ if ($_.Control -and $_.KeyCode -eq 'Return') { $f.DialogResult = [System.Windows.Forms.DialogResult]::OK; $f.Close() } })
# The process is started hidden (no console flash); Windows applies that to the first window shown,
# so show the form explicitly once its handle exists.
$f.Add_Load({ [HSD.Win]::ShowWindow($f.Handle, 5) | Out-Null; [HSD.Win]::SetForegroundWindow($f.Handle) | Out-Null })
$f.Add_Shown({ $f.Activate(); $t.Focus() })
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write('OK:' + $t.Text) } else { [Console]::Out.Write('CANCEL') }
`;

export const systemDesktop: Desktop = {
	async readClipboard() {
		if (WIN) return powershell("$c = Get-Clipboard -Raw; if ($c) { [Console]::Out.Write($c) }");
		if (process.platform === "darwin") return run("pbpaste", []);
		throw new Error("Clipboard is not supported on this system");
	},

	async writeClipboard(text) {
		if (WIN) {
			await powershell("Set-Clipboard -Value ([Console]::In.ReadToEnd())", { input: text });
			return;
		}
		if (process.platform === "darwin") {
			await run("pbcopy", [], { input: text });
			return;
		}
		throw new Error("Clipboard is not supported on this system");
	},

	async openFile(path) {
		if (WIN) {
			// explorer.exe opens the file with its associated app; it exits with code 1 even on success.
			await run("explorer.exe", [path]).catch(() => undefined);
			return;
		}
		await run(process.platform === "darwin" ? "open" : "xdg-open", [path]);
	},

	async askInput(title) {
		if (!WIN) throw new Error("The input dialog is only available on Windows so far");
		const out = await powershell(INPUT_DIALOG, { env: { HSD_TITLE: title }, timeoutMs: 30 * 60_000 });
		return out.startsWith("OK:") ? out.slice(3).replace(/\r\n/g, "\n") : undefined;
	},

	async documentsDir() {
		if (WIN) {
			try {
				// Honors folder redirection (e.g. to OneDrive).
				const dir = (await powershell("[Console]::Out.Write([Environment]::GetFolderPath('MyDocuments'))")).trim();
				if (dir) return dir;
			} catch {
				// fall through
			}
		}
		return join(homedir(), "Documents");
	},
};
