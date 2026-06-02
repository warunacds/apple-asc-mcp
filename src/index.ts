#!/usr/bin/env node
/**
 * app-store-connect-mcp — Model Context Protocol server that lets Claude drive
 * App Store Connect end-to-end (build, upload, metadata, screenshots, submit).
 *
 * Transport: stdio. Wire it into Claude Code via:
 *   claude mcp add app-store-connect-mcp -- node /path/to/dist/index.js
 *
 * `--diagnose` runs a credential / Xcode preflight and exits without starting MCP.
 *
 * All output to stdout is the MCP protocol; logs go to stderr and ~/logs/app-store-connect-mcp/.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, ConfigError } from "./config.js";
import { JwtMinter } from "./auth.js";
import { AscClient, AscApiError } from "./client.js";
import { ALL_TOOLS } from "./tools/index.js";
import { jsonSchemaFor, type ToolContext } from "./tools/registry.js";
import { log } from "./log.js";
import { runDiagnose } from "./diagnose.js";

// Single source of truth for the version. package.json ships at the package
// root, one level up from this file's compiled location in dist/.
const VERSION: string = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
).version;
const SERVER_NAME = "app-store-connect-mcp";

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--diagnose") || argv.includes("-d")) {
    const code = await runDiagnose();
    process.exit(code);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(usage());
    process.exit(0);
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_NAME} ${VERSION}\n`);
    process.exit(0);
  }

  log.info("app-store-connect-mcp starting", { pid: process.pid, node: process.version });

  // Lazy: don't fail startup if creds are missing — let `asc_whoami` surface the error
  // when first called. This lets the server boot in environments where creds aren't yet set.
  let ctx: ToolContext | undefined;
  let configError: Error | undefined;
  try {
    const config = loadConfig();
    const minter = new JwtMinter(config);
    const client = new AscClient(minter);
    ctx = { config, client };
    log.info("loaded App Store Connect credentials", { keyId: config.keyId, issuerId: config.issuerId, keyPath: config.privateKeyPath });
  } catch (err) {
    configError = err as Error;
    log.warn("App Store Connect credentials not loaded yet (server will still start; run with --diagnose to debug)", { err: (err as Error).message });
  }

  const server = new Server(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: jsonSchemaFor(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
    const name = req.params.name;
    const tool = ALL_TOOLS.find((t) => t.name === name);
    if (!tool) {
      return mcpError(`Unknown tool: ${name}. Use list_tools to see what's available.`);
    }

    if (!ctx) {
      const detail = configError instanceof ConfigError
        ? configError.message
        : `Server failed to load App Store Connect credentials: ${configError?.message ?? "unknown error"}`;
      return mcpError(
        `App Store Connect credentials are not configured. ${detail} ` +
        `Set APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID, and APP_STORE_CONNECT_PRIVATE_KEY_PATH (or place AuthKey_<KEYID>.p8 under ~/.appstoreconnect/private_keys/). ` +
        `Run \`app-store-connect-mcp --diagnose\` to debug interactively.`,
      );
    }

    log.info(`tool_call: ${name}`, { args: redactArgs(req.params.arguments) });
    let parsed: unknown;
    try {
      parsed = tool.inputSchema.parse(req.params.arguments ?? {});
    } catch (err) {
      return mcpError(`Invalid input for ${name}: ${(err as Error).message}`);
    }
    try {
      const result = await tool.handler(parsed, ctx);
      log.info(`tool_ok: ${name}`);
      return {
        content: [
          { type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      log.error(`tool_err: ${name}`, err);
      if (err instanceof AscApiError) {
        return mcpError(err.message + "\n\nFull errors: " + JSON.stringify(err.errors, null, 2));
      }
      return mcpError((err as Error).message ?? String(err));
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("app-store-connect-mcp ready (stdio)");

  // Graceful shutdown — give in-flight tool calls a moment to finish before exit.
  const shutdown = (sig: string) => {
    log.info(`received ${sig}, shutting down`);
    server.close().catch((e) => log.error("error closing server", e)).finally(() => {
      // Brief grace period for log writes.
      setTimeout(() => process.exit(0), 100);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException", err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    log.error("unhandledRejection", err);
  });
}

function mcpError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function redactArgs(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const REDACT = ["password", "demoAccountPassword", "apiKey", "token", "Authorization"];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (REDACT.some((r) => k.toLowerCase().includes(r.toLowerCase()))) out[k] = "<redacted>";
    else if (typeof v === "string" && v.length > 200) out[k] = v.slice(0, 200) + "…";
    else out[k] = v;
  }
  return out;
}

function usage(): string {
  return `app-store-connect-mcp — Model Context Protocol server for App Store Connect

USAGE
  app-store-connect-mcp [options]

OPTIONS
  --diagnose, -d   Run preflight checks (creds, JWT, API reachability, Xcode) and exit.
  --version, -v    Print version and exit.
  --help, -h       This message.

ENVIRONMENT
  APP_STORE_CONNECT_KEY_ID            10-character Key ID (required)
  APP_STORE_CONNECT_ISSUER_ID         UUID of the issuer (required)
  APP_STORE_CONNECT_PRIVATE_KEY_PATH  path to AuthKey_<KEYID>.p8 (or)
  APP_STORE_CONNECT_PRIVATE_KEY       PEM contents inline
  APP_STORE_CONNECT_PREFER_REST_UPLOAD  "true" (default) or "false"

EXAMPLES
  app-store-connect-mcp --diagnose
  claude mcp add app-store-connect-mcp -- node $(npm root -g)/app-store-connect-mcp/dist/index.js

Logs: ~/logs/app-store-connect-mcp/<date>.log
`;
}

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
