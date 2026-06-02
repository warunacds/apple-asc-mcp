import { mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), "logs", "app-store-connect-mcp");
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);

type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const line = extra !== undefined
    ? `${ts} ${level.toUpperCase()} ${msg} ${safeStringify(extra)}\n`
    : `${ts} ${level.toUpperCase()} ${msg}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // Best-effort; never crash the server because logging failed.
  }
  // Mirror to stderr (stdout is reserved for the MCP stdio transport).
  process.stderr.write(line);
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) => {
      if (val instanceof Error) return { name: val.name, message: val.message, stack: val.stack };
      if (val instanceof Buffer) return `<Buffer ${val.length} bytes>`;
      if (typeof val === "string" && val.length > 2000) return val.slice(0, 2000) + "…";
      return val;
    });
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (m: string, extra?: unknown) => write("debug", m, extra),
  info: (m: string, extra?: unknown) => write("info", m, extra),
  warn: (m: string, extra?: unknown) => write("warn", m, extra),
  error: (m: string, extra?: unknown) => write("error", m, extra),
  file: LOG_FILE,
};
