// ABOUTME: Builds the soopdoop Mac app (apps/hud) on this machine and installs it as ~/Applications/soopdoop.app: a menu bar
// ABOUTME: app (no Dock icon), signed for this Mac only. Built from source, so nothing downloaded needs Apple's notarization.
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const APP_BUNDLE_ID = "com.soopdoop.app";

export function appBundlePath(): string {
  return path.join(homedir(), "Applications", "soopdoop.app");
}

export function appBinaryPath(): string {
  return path.join(appBundlePath(), "Contents", "MacOS", "Soopdoop");
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// LSUIElement: no Dock icon; the app lives in the menu bar and the HUD.
export function infoPlist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${APP_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>soopdoop</string>
  <key>CFBundleDisplayName</key>
  <string>soopdoop</string>
  <key>CFBundleExecutable</key>
  <string>Soopdoop</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${xml(version)}</string>
  <key>CFBundleVersion</key>
  <string>${xml(version)}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

function run(cmd: string[], cwd: string): { code: number; output: string } {
  const res = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: res.exitCode, output: res.stdout.toString() + res.stderr.toString() };
}

// Xcode or its command line tools. Checked first: running `swift` without them pops up Apple's install dialog.
export function canBuild(): boolean {
  if (process.platform !== "darwin") return false;
  return run(["xcode-select", "-p"], "/").code === 0 && run(["xcrun", "--find", "swift"], "/").code === 0;
}

// Builds the app and swaps it into place. A running copy keeps its old files until it restarts.
export async function buildApp(root: string, version: string): Promise<{ ok: true; path: string } | { ok: false; why: string }> {
  if (!canBuild()) return { ok: false, why: "Xcode's command line tools are missing. Install them with `xcode-select --install`, then run soopdoop setup again." };
  const pkg = path.join(root, "apps", "hud");
  const build = run(["xcrun", "swift", "build", "-c", "release", "--package-path", pkg], root);
  if (build.code !== 0) return { ok: false, why: `swift build failed: ${build.output.trim().split("\n").slice(-4).join(" ")}` };

  const target = appBundlePath();
  const staging = `${target}.new`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, "Contents", "MacOS"), { recursive: true });
  await mkdir(path.join(staging, "Contents", "Resources"), { recursive: true });
  const binary = path.join(staging, "Contents", "MacOS", "Soopdoop");
  await Bun.write(binary, Bun.file(path.join(pkg, ".build", "release", "Soopdoop")));
  await chmod(binary, 0o755);
  await Bun.write(path.join(staging, "Contents", "Info.plist"), infoPlist(version));
  // Ad-hoc: signed for this Mac. Built here from source, so Gatekeeper has nothing downloaded to check.
  const sign = run(["codesign", "--force", "--sign", "-", staging], root);
  if (sign.code !== 0) return { ok: false, why: `codesign failed: ${sign.output.trim()}` };

  const old = `${target}.old`;
  await rm(old, { recursive: true, force: true });
  if (await Bun.file(path.join(target, "Contents", "Info.plist")).exists()) await rename(target, old);
  await rename(staging, target);
  await rm(old, { recursive: true, force: true });
  return { ok: true, path: target };
}

export async function removeApp(): Promise<void> {
  await rm(appBundlePath(), { recursive: true, force: true });
}
