#!/usr/bin/env node
/**
 * appstore-connect-mcp — Model Context Protocol server that lets Claude drive
 * App Store Connect end-to-end (build, upload, metadata, screenshots, submit).
 *
 * Transport: stdio. Wire it into Claude Code via:
 *   claude mcp add appstore-connect-mcp -- node /path/to/dist/index.js
 *
 * All output to stdout is the MCP protocol; logs go to stderr and ~/logs/appstore-connect-mcp/.
 */
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

async function main() {
  log.info("appstore-connect-mcp starting", { pid: process.pid, node: process.version });

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
    log.warn("App Store Connect credentials not loaded yet (server will still start)", { err: (err as Error).message });
  }

  const server = new Server(
    { name: "appstore-connect-mcp", version: "0.1.0" },
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
        `Set APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID, and APP_STORE_CONNECT_PRIVATE_KEY_PATH (or place AuthKey_<KEYID>.p8 under ~/.appstoreconnect/private_keys/).`,
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
  log.info("appstore-connect-mcp ready (stdio)");
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

main().catch((err) => {
  log.error("fatal", err);
  process.exit(1);
});
