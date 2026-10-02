// ABOUTME: Keeps the rail and the daemon running in the background as macOS LaunchAgents: they start at login and restart if they exit.
// ABOUTME: The service list and plist text are pure functions (tested); the launchctl, lsof and open calls are thin wrappers.
import { homedir } from "node:os";
import path from "node:path";

export const RAIL_PORT = 47312;
export const DAEMON_PORT = 47311;
export const RAIL_URL = `http://127.0.0.1:${RAIL_PORT}/`;

export interface ServiceSpec {
  name: "rail" | "daemon";
  label: string;
  program: string[];
  workingDirectory: string;
  env: Record<string, string>;
  log: string;
  port: number;
}

// root: the soopdoop checkout. bun: an absolute path, because launchd does not read your shell's PATH.
export function serviceSpecs(root: string, bun: string, home: string, soopdoopHomeOverride?: string): ServiceSpec[] {
  const env: Record<string, string> = {
    PATH: `${path.dirname(bun)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    // The rail serves a built page and keeps browser console lines out of its log.
    SOOPDOOP_SERVICE: "1",
  };
  if (soopdoopHomeOverride !== undefined) env.SOOPDOOP_HOME = soopdoopHomeOverride;
  const logs = path.join(home, "logs");
  return [
    {
      name: "rail",
      label: "com.soopdoop.rail",
      program: [bun, path.join(root, "apps", "rail", "serve.ts")],
      workingDirectory: path.join(root, "apps", "rail"),
      env,
      log: path.join(logs, "rail.log"),
      port: RAIL_PORT,
    },
    {
      name: "daemon",
      label: "com.soopdoop.daemon",
      program: [bun, path.join(root, "apps", "daemon", "src", "cli.ts"), "serve"],
      workingDirectory: root,
      env,
      log: path.join(logs, "daemon.log"),
      port: DAEMON_PORT,
    },
  ];
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// RunAtLoad starts it at login; KeepAlive restarts it whenever it exits; ThrottleInterval spaces out restarts.
export function plist(spec: ServiceSpec): string {
  const args = spec.program.map(function (a) { return `    <string>${xml(a)}</string>`; }).join("\n");
  const env = Object.entries(spec.env)
    .map(function ([k, v]) { return `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`; })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(spec.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(spec.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(spec.log)}</string>
</dict>
</plist>
`;
}

export function plistPath(label: string): string {
  return path.join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out + err };
}

export async function isLoaded(label: string): Promise<boolean> {
  return (await run(["launchctl", "print", `${domain()}/${label}`])).code === 0;
}

// Unloads the service if it is loaded. Quiet when it is not.
export async function unload(label: string): Promise<void> {
  if (await isLoaded(label)) await run(["launchctl", "bootout", `${domain()}/${label}`]);
}

export async function load(spec: ServiceSpec): Promise<void> {
  await Bun.write(plistPath(spec.label), plist(spec));
  await unload(spec.label);
  const res = await run(["launchctl", "bootstrap", domain(), plistPath(spec.label)]);
  if (res.code !== 0) throw new Error(`launchctl could not start ${spec.label}: ${res.out.trim()}`);
}

export async function restart(label: string): Promise<void> {
  const res = await run(["launchctl", "kickstart", "-k", `${domain()}/${label}`]);
  if (res.code !== 0) throw new Error(`launchctl could not restart ${label}: ${res.out.trim()}`);
}

// Who is listening on a port: their pid and command line, or null when the port is free.
export async function portOwner(port: number): Promise<{ pid: number; command: string } | null> {
  const res = await run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const pid = Number(res.out.trim().split("\n")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const ps = await run(["ps", "-o", "command=", "-p", String(pid)]);
  return { pid, command: ps.out.trim() };
}

// Polls until `check` passes or the time runs out.
export async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return true;
    await Bun.sleep(250);
  }
  return false;
}

export async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function openInBrowser(url: string): Promise<void> {
  await run([process.platform === "darwin" ? "open" : "xdg-open", url]);
}
