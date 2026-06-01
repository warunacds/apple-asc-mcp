import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Alternative distribution (EU DMA): distributing iOS apps outside the App Store / via alternative
 * marketplaces. This is a newer, EU-only, niche surface — the LEAST mature here, so everything is
 * heavily [VERIFY] and not validated against live Apple traffic.
 */

export const getAltDistributionKeyTool = tool({
  name: "asc_get_alt_distribution_key",
  description: "Get the app's alternative-distribution public key (used to sign alternatively-distributed builds).",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.get(`/v1/apps/${input.appId}/alternativeDistributionKey`, {
      query: { "fields[alternativeDistributionKeys]": "publicKey" },
    }).catch(() => ({ data: null }));
  },
});

export const createAltDistributionKeyTool = tool({
  name: "asc_create_alt_distribution_key",
  description: "Register the app's alternative-distribution public key (PEM). Required before distributing outside the App Store in the EU.",
  inputSchema: z.object({
    appId: z.string(),
    publicKey: z.string().describe("PEM-encoded public key."),
  }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string } }>("/v1/alternativeDistributionKeys", {
      data: {
        type: "alternativeDistributionKeys",
        attributes: { publicKey: input.publicKey },
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    });
    return { ok: true, keyId: res.data.id, appId: input.appId };
  },
});

export const listAltDistributionPackagesTool = tool({
  name: "asc_list_alt_distribution_packages",
  description: "List alternative-distribution packages for an app (the EU sideloadable build artifacts) with their state.",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const pkgs = await client.list(`/v1/apps/${input.appId}/alternativeDistributionPackages`, { limit: 100 }).catch(() => []);
    return pkgs.map((p) => ({ id: p.id, ...p.attributes }));
  },
});

export const listMarketplaceDomainsTool = tool({
  name: "asc_list_marketplace_domains",
  description: "List registered alternative-marketplace domains (for operating an EU app marketplace).",
  inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(100).optional() }).strict(),
  handler: async (input, { client }) => {
    const domains = await client.list("/v1/marketplaceDomains", { limit: input.limit ?? 100 }).catch(() => []);
    return domains.map((d) => ({ id: d.id, ...d.attributes }));
  },
});

export const createMarketplaceDomainTool = tool({
  name: "asc_create_marketplace_domain",
  description: "Register a domain for an alternative app marketplace (EU DMA).",
  inputSchema: z.object({ domain: z.string().describe("The marketplace domain, e.g. apps.example.eu.") }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string } }>("/v1/marketplaceDomains", {
      data: { type: "marketplaceDomains", attributes: { domain: input.domain } },
    });
    return { ok: true, marketplaceDomainId: res.data.id, domain: input.domain };
  },
});
