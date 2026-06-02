import { z } from "zod";
import { tool } from "./registry.js";

/**
 * App Store Connect webhooks (2024+): subscribe an HTTPS endpoint to app events. Create-request shape
 * confirmed against the OpenAPI spec — all of name/url/eventTypes/secret/enabled are required.
 */

export const listWebhooksTool = tool({
  name: "asc_list_webhooks",
  description: "List webhooks configured for an app (id, name, url, enabled, eventTypes).",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const hooks = await client.list(`/v1/apps/${input.appId}/webhooks`, {
      limit: 200,
      "fields[webhooks]": "name,url,enabled,eventTypes",
    });
    return hooks.map((h) => ({ id: h.id, ...h.attributes }));
  },
});

export const createWebhookTool = tool({
  name: "asc_create_webhook",
  description:
    "Create a webhook for an app. url must be HTTPS; eventTypes is the list of events to subscribe to (e.g. " +
    "APP_STORE_VERSION_APP_VERSION_STATE_UPDATED, APP_STORE_VERSION_STATE_UPDATED). secret is required — Apple uses " +
    "it to sign each delivery so you can verify authenticity.",
  inputSchema: z.object({
    appId: z.string(),
    name: z.string(),
    url: z.string().url(),
    eventTypes: z.array(z.string()).min(1).describe("Event type identifiers to subscribe to."),
    secret: z.string().describe("Signing secret Apple uses to sign deliveries (required)."),
    enabled: z.boolean().default(true),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = { name: input.name, url: input.url, eventTypes: input.eventTypes, secret: input.secret, enabled: input.enabled };
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/webhooks", {
      data: { type: "webhooks", attributes, relationships: { app: { data: { type: "apps", id: input.appId } } } },
    });
    return { ok: true, webhookId: res.data.id, ...res.data.attributes };
  },
});

export const updateWebhookTool = tool({
  name: "asc_update_webhook",
  description: "Update a webhook (name, url, eventTypes, enabled, secret). Only the fields you pass change.",
  inputSchema: z.object({
    webhookId: z.string(),
    name: z.string().optional(),
    url: z.string().url().optional(),
    eventTypes: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    secret: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {};
    for (const k of ["name", "url", "eventTypes", "enabled", "secret"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    return await client.patch(`/v1/webhooks/${input.webhookId}`, {
      data: { type: "webhooks", id: input.webhookId, attributes },
    });
  },
});

export const deleteWebhookTool = tool({
  name: "asc_delete_webhook",
  description: "Delete a webhook by id.",
  inputSchema: z.object({ webhookId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/webhooks/${input.webhookId}`);
    return { ok: true, webhookId: input.webhookId };
  },
});

export const pingWebhookTool = tool({
  name: "asc_ping_webhook",
  description: "Send a test ping to a webhook to verify the endpoint receives deliveries.",
  inputSchema: z.object({ webhookId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string } }>("/v1/webhookPings", {
      data: { type: "webhookPings", relationships: { webhook: { data: { type: "webhooks", id: input.webhookId } } } },
    });
    return { ok: true, pingId: res.data.id, webhookId: input.webhookId };
  },
});

export const listWebhookDeliveriesTool = tool({
  name: "asc_list_webhook_deliveries",
  description: "List recent delivery attempts for a webhook (status, response code, timestamps) — useful for debugging.",
  inputSchema: z.object({
    webhookId: z.string(),
    limit: z.number().int().min(1).max(200).default(50).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const deliveries = await client.list(`/v1/webhooks/${input.webhookId}/deliveries`, {
      limit: input.limit ?? 50,
      sort: "-createdDate",
    });
    return deliveries.map((d) => ({ id: d.id, ...d.attributes }));
  },
});
