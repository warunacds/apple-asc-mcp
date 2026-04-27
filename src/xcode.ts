import { spawn } from "node:child_process";
import { platform } from "node:os";
import { existsSync } from "node:fs";
import { log } from "./log.js";

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class XcodeToolError extends Error {
  constructor(public readonly tool: string, public readonly result: SpawnResult, summary: string) {
    super(`${tool} failed: ${summary}`);
  }
}

export function ensureMac(): void {
  if (platform() !== "darwin") {
    throw new Error(
      `xcodebuild and altool require macOS with Xcode. Detected platform: ${platform()}. ` +
      `You can still use the REST-only tools (asc_*) on any platform.`,
    );
  }
}

export async function runCmd(cmd: string, args: string[], opts: { env?: Record<string, string>; cwd?: string; timeoutMs?: number; stdin?: string } = {}): Promise<SpawnResult> {
  log.debug(`spawn: ${cmd} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000);
      }, opts.timeoutMs);
    }
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("error", (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    if (opts.stdin) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}

export interface ArchiveOptions {
  /** Either workspacePath OR projectPath must be set. */
  workspacePath?: string;
  projectPath?: string;
  scheme: string;
  configuration?: string;
  archivePath: string;
  destination?: string; // default "generic/platform=iOS"
  /** "iOS" | "macOS" | "tvOS" | "visionOS" | "watchOS" — sets a sensible destination if `destination` not given. */
  platformPreset?: "iOS" | "macOS" | "tvOS" | "visionOS" | "watchOS";
  /** When using API key for automatic provisioning. Empty for manual signing. */
  authenticationKeyPath?: string;
  authenticationKeyId?: string;
  authenticationKeyIssuerId?: string;
  allowProvisioningUpdates?: boolean;
  extraBuildSettings?: Record<string, string>; // e.g. DEVELOPMENT_TEAM=ABCD123456
  timeoutMs?: number;
}

export async function xcArchive(opts: ArchiveOptions): Promise<SpawnResult> {
  ensureMac();
  if (!opts.workspacePath && !opts.projectPath) {
    throw new Error("xcArchive requires either workspacePath or projectPath.");
  }
  const args: string[] = [];
  if (opts.workspacePath) args.push("-workspace", opts.workspacePath);
  if (opts.projectPath) args.push("-project", opts.projectPath);
  args.push("-scheme", opts.scheme);
  args.push("-configuration", opts.configuration ?? "Release");
  args.push("-destination", opts.destination ?? destinationForPlatform(opts.platformPreset ?? "iOS"));
  args.push("-archivePath", opts.archivePath);
  args.push("archive");
  if (opts.allowProvisioningUpdates) args.push("-allowProvisioningUpdates");
  if (opts.authenticationKeyPath) args.push("-authenticationKeyPath", opts.authenticationKeyPath);
  if (opts.authenticationKeyId) args.push("-authenticationKeyID", opts.authenticationKeyId);
  if (opts.authenticationKeyIssuerId) args.push("-authenticationKeyIssuerID", opts.authenticationKeyIssuerId);
  for (const [k, v] of Object.entries(opts.extraBuildSettings ?? {})) args.push(`${k}=${v}`);

  const result = await runCmd("xcodebuild", args, { timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000 });
  if (result.exitCode !== 0) {
    const tail = (result.stderr + "\n" + result.stdout).split("\n").slice(-30).join("\n");
    throw new XcodeToolError("xcodebuild archive", result, `exit ${result.exitCode}\n${tail}`);
  }
  if (!existsSync(opts.archivePath)) {
    throw new XcodeToolError("xcodebuild archive", result, `archive missing at ${opts.archivePath}`);
  }
  return result;
}

function destinationForPlatform(p: ArchiveOptions["platformPreset"]): string {
  switch (p) {
    case "macOS": return "generic/platform=macOS";
    case "tvOS": return "generic/platform=tvOS";
    case "visionOS": return "generic/platform=visionOS";
    case "watchOS": return "generic/platform=watchOS";
    default: return "generic/platform=iOS";
  }
}

export interface ExportOptions {
  archivePath: string;
  exportOptionsPlist: string; // path to plist
  exportPath: string; // output dir
  authenticationKeyPath?: string;
  authenticationKeyId?: string;
  authenticationKeyIssuerId?: string;
  allowProvisioningUpdates?: boolean;
  timeoutMs?: number;
}

export async function xcExportArchive(opts: ExportOptions): Promise<SpawnResult> {
  ensureMac();
  const args = [
    "-exportArchive",
    "-archivePath", opts.archivePath,
    "-exportOptionsPlist", opts.exportOptionsPlist,
    "-exportPath", opts.exportPath,
  ];
  if (opts.allowProvisioningUpdates) args.push("-allowProvisioningUpdates");
  if (opts.authenticationKeyPath) args.push("-authenticationKeyPath", opts.authenticationKeyPath);
  if (opts.authenticationKeyId) args.push("-authenticationKeyID", opts.authenticationKeyId);
  if (opts.authenticationKeyIssuerId) args.push("-authenticationKeyIssuerID", opts.authenticationKeyIssuerId);

  const result = await runCmd("xcodebuild", args, { timeoutMs: opts.timeoutMs ?? 15 * 60 * 1000 });
  if (result.exitCode !== 0) {
    const tail = (result.stderr + "\n" + result.stdout).split("\n").slice(-30).join("\n");
    throw new XcodeToolError("xcodebuild -exportArchive", result, `exit ${result.exitCode}\n${tail}`);
  }
  return result;
}

export interface AltoolOptions {
  ipaPath: string;
  type: "ios" | "macos" | "appletvos" | "visionos";
  apiKey: string;          // 10-char Key ID
  apiIssuer: string;       // UUID
  /** Optional path that contains AuthKey_<KEYID>.p8 (sets API_PRIVATE_KEYS_DIR for altool). */
  apiKeyDir?: string;
  appleId?: string;        // numeric App ID for nicer errors
  bundleId?: string;
  bundleVersion?: string;
  bundleShortVersionString?: string;
  validateOnly?: boolean;
  timeoutMs?: number;
}

export async function altoolUploadOrValidate(opts: AltoolOptions): Promise<SpawnResult & { json?: AltoolJson }> {
  ensureMac();
  const args: string[] = [];
  args.push(opts.validateOnly ? "--validate-app" : "--upload-package", opts.ipaPath);
  args.push("-t", opts.type);
  if (opts.appleId) args.push("--apple-id", opts.appleId);
  if (opts.bundleId) args.push("--bundle-id", opts.bundleId);
  if (opts.bundleVersion) args.push("--bundle-version", opts.bundleVersion);
  if (opts.bundleShortVersionString) args.push("--bundle-short-version-string", opts.bundleShortVersionString);
  args.push("--apiKey", opts.apiKey);
  args.push("--apiIssuer", opts.apiIssuer);
  args.push("--output-format", "json");

  const env: Record<string, string> = {};
  if (opts.apiKeyDir) env.API_PRIVATE_KEYS_DIR = opts.apiKeyDir;
  const result = await runCmd("xcrun", ["altool", ...args], { env, timeoutMs: opts.timeoutMs ?? 60 * 60 * 1000 });

  // altool can exit 0 with `product-errors` populated. Parse stdout JSON and treat both as authoritative.
  let json: AltoolJson | undefined;
  try {
    json = result.stdout.trim() ? (JSON.parse(result.stdout) as AltoolJson) : undefined;
  } catch {
    json = undefined;
  }
  const productErrors = json?.["product-errors"] ?? [];
  if (result.exitCode !== 0 || productErrors.length > 0) {
    const summary = productErrors.length
      ? productErrors.map((e) => `[${e.code ?? "?"}] ${e.message}`).join("; ")
      : `exit ${result.exitCode} ${result.stderr.slice(-500)}`;
    throw new XcodeToolError(opts.validateOnly ? "altool --validate-app" : "altool --upload-package", result, summary);
  }
  return { ...result, json };
}

export interface AltoolJson {
  "tool-version"?: string;
  "tool-path"?: string;
  "os-version"?: string;
  "success-message"?: string;
  "product-errors"?: { code?: string | number; message: string; userInfo?: Record<string, unknown> }[];
  details?: Record<string, unknown>;
}
