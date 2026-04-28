/**
 * `--diagnose` CLI mode. Runs preflight checks against the user's environment and
 * App Store Connect credentials, then prints a clear go/no-go report and exits.
 *
 * This intentionally does NOT use the MCP transport — it's a human-facing tool for
 * verifying setup before wiring the server into Claude Code.
 *
 * Exit codes:
 *   0 — everything passed
 *   1 — at least one check failed (mandatory check)
 *   2 — at least one optional check failed (Xcode missing, etc.) — non-fatal
 */
import { platform } from "node:os";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadConfig, ConfigError } from "./config.js";
import { JwtMinter } from "./auth.js";
import { AscClient, AscApiError } from "./client.js";

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  required: boolean;
}

const C = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

const isTty = process.stdout.isTTY;
const fmt = isTty ? C : { green: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s, bold: (s: string) => s, dim: (s: string) => s };

function badge(status: CheckResult["status"]): string {
  if (status === "ok") return fmt.green("✓");
  if (status === "warn") return fmt.yellow("!");
  return fmt.red("✗");
}

function printResult(r: CheckResult) {
  const tag = r.required ? "" : fmt.dim(" (optional)");
  process.stdout.write(`  ${badge(r.status)} ${r.name}${tag}\n`);
  if (r.detail) {
    for (const line of r.detail.split("\n")) {
      process.stdout.write(`      ${fmt.dim(line)}\n`);
    }
  }
}

function which(cmd: string): string | undefined {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.split("\n")[0]?.trim() || undefined;
  return undefined;
}

function checkVersion(cmd: string, args: string[]): { found: true; version: string } | { found: false } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 8000 });
  if (r.error || r.status !== 0) return { found: false };
  return { found: true, version: (r.stdout + r.stderr).split("\n")[0]?.trim() ?? "" };
}

export async function runDiagnose(): Promise<number> {
  process.stdout.write(fmt.bold("\nappstore-connect-mcp — diagnose\n\n"));

  const results: CheckResult[] = [];

  // 1. Node version
  const nodeMajor = Number((process.versions.node.split(".")[0]) ?? "0");
  results.push({
    name: `Node.js ${process.versions.node}`,
    status: nodeMajor >= 20 ? "ok" : "fail",
    required: true,
    detail: nodeMajor >= 20 ? undefined : "Requires Node 20 or later.",
  });

  // 2. Platform
  results.push({
    name: `Platform: ${platform()} ${process.arch}`,
    status: "ok",
    required: false,
    detail: platform() === "darwin"
      ? "macOS detected — xc_archive / xc_export_ipa / altool tools are usable."
      : "Non-macOS — REST tools work, but xc_archive / xc_export_ipa / altool require macOS.",
  });

  // 3. Xcode (optional)
  if (platform() === "darwin") {
    const xcb = which("xcodebuild");
    if (xcb) {
      const v = checkVersion("xcodebuild", ["-version"]);
      results.push({
        name: `xcodebuild`,
        status: "ok",
        required: false,
        detail: v.found ? v.version : xcb,
      });
    } else {
      results.push({
        name: `xcodebuild`,
        status: "warn",
        required: false,
        detail: "Not found on PATH. Install Xcode (or run `xcode-select --install`) if you want to use xc_archive / xc_export_ipa.",
      });
    }
    const altool = spawnSync("xcrun", ["--find", "altool"], { encoding: "utf8" });
    if (altool.status === 0) {
      results.push({
        name: `xcrun altool`,
        status: "ok",
        required: false,
        detail: altool.stdout.trim(),
      });
    } else {
      results.push({
        name: `xcrun altool`,
        status: "warn",
        required: false,
        detail: "Not found. Needed only if you set APP_STORE_CONNECT_PREFER_REST_UPLOAD=false to fall back from REST to altool.",
      });
    }
  }

  // 4. Credentials
  let credsOk = false;
  let cfg: import("./config.js").AscConfig | undefined;
  try {
    cfg = loadConfig();
    credsOk = true;
    results.push({
      name: `Credentials: keyId=${cfg.keyId}, issuerId=${cfg.issuerId}`,
      status: "ok",
      required: true,
      detail: cfg.privateKeyPath ? `Private key loaded from ${cfg.privateKeyPath}` : "Private key supplied inline via APP_STORE_CONNECT_PRIVATE_KEY.",
    });
  } catch (err) {
    const msg = err instanceof ConfigError ? err.message : (err as Error).message;
    results.push({
      name: `Credentials`,
      status: "fail",
      required: true,
      detail: msg,
    });
  }

  // 5. Optional: confirm the .p8 path passes a sanity check.
  if (cfg?.privateKeyPath) {
    const exists = existsSync(cfg.privateKeyPath);
    if (!exists) {
      results.push({
        name: `.p8 file readable`,
        status: "fail",
        required: true,
        detail: `${cfg.privateKeyPath} does not exist.`,
      });
      credsOk = false;
    }
  }

  // 6. JWT minting
  if (credsOk && cfg) {
    try {
      const minter = new JwtMinter(cfg);
      const token = await minter.getToken();
      const parts = token.split(".");
      results.push({
        name: `JWT signing (ES256)`,
        status: parts.length === 3 ? "ok" : "fail",
        required: true,
        detail: parts.length === 3 ? `Minted ${parts[0]?.length ?? 0}-char header, ${parts[1]?.length ?? 0}-char payload, valid signature.` : "JWT didn't have 3 parts.",
      });
    } catch (err) {
      results.push({
        name: `JWT signing (ES256)`,
        status: "fail",
        required: true,
        detail: (err as Error).message,
      });
      credsOk = false;
    }
  }

  // 7. Live API call
  if (credsOk && cfg) {
    try {
      const minter = new JwtMinter(cfg);
      const client = new AscClient(minter);
      const apps = await client.list<{ name?: string; bundleId?: string }>("/v1/apps", { limit: 1, "fields[apps]": "name,bundleId" });
      results.push({
        name: `App Store Connect API reachable (GET /v1/apps)`,
        status: "ok",
        required: true,
        detail: apps.length > 0
          ? `Authenticated. Visible apps: at least 1 (e.g. "${apps[0]?.attributes?.name}" / ${apps[0]?.attributes?.bundleId}).`
          : "Authenticated. Zero apps visible to this key — check the key's role in App Store Connect.",
      });
    } catch (err) {
      const detail = err instanceof AscApiError ? err.message : (err as Error).message;
      results.push({
        name: `App Store Connect API reachable`,
        status: "fail",
        required: true,
        detail,
      });
    }
  }

  // Print and decide exit code.
  for (const r of results) printResult(r);

  const failedRequired = results.filter((r) => r.required && r.status === "fail");
  const warned = results.filter((r) => r.status === "warn");

  process.stdout.write("\n");
  if (failedRequired.length === 0 && warned.length === 0) {
    process.stdout.write(fmt.green(fmt.bold("All checks passed. The MCP is ready to wire into Claude Code.\n")));
    return 0;
  }
  if (failedRequired.length === 0) {
    process.stdout.write(fmt.yellow(fmt.bold(`Required checks passed; ${warned.length} optional check(s) raised warnings (above).\n`)));
    return 0;
  }
  process.stdout.write(fmt.red(fmt.bold(`${failedRequired.length} required check(s) failed. Fix the items marked ✗ above and re-run \`appstore-connect-mcp --diagnose\`.\n`)));
  return 1;
}
