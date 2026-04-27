import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { AscClient } from "../client.js";
import type { AscConfig } from "../config.js";

/**
 * A single tool, ready to register with the MCP server.
 *
 * `inputSchema` is a Zod schema; we lift it to JSON schema for the MCP wire format.
 * Handlers return any JSON-serializable value; the runtime stringifies it for the client.
 */
export interface Tool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: I;
  handler: (input: z.infer<I>, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  client: AscClient;
  config: AscConfig;
}

export function tool<I extends z.ZodTypeAny>(t: Tool<I>): Tool {
  return t as unknown as Tool;
}

export function jsonSchemaFor(schema: z.ZodTypeAny): Record<string, unknown> {
  // MCP wants a plain JSON-Schema object describing the tool's input.
  const raw = zodToJsonSchema(schema, { target: "openApi3" }) as Record<string, unknown>;
  // Strip top-level $schema/$ref noise.
  delete raw.$schema;
  delete (raw as { definitions?: unknown }).definitions;
  return raw;
}
