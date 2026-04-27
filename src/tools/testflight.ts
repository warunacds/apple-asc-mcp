import { z } from "zod";
import { tool } from "./registry.js";

export const listBetaGroupsTool = tool({
  name: "asc_list_beta_groups",
  description: "List TestFlight beta groups for an app (internal & external).",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const groups = await client.list<{ name?: string; isInternalGroup?: boolean; publicLinkEnabled?: boolean; publicLink?: string; hasAccessToAllBuilds?: boolean }>(
      "/v1/betaGroups",
      { "filter[app]": input.appId, limit: 100, "fields[betaGroups]": "name,isInternalGroup,publicLinkEnabled,publicLink,hasAccessToAllBuilds,feedbackEnabled" },
    );
    return groups.map((g) => ({ id: g.id, ...g.attributes }));
  },
});

export const setBetaWhatsNewTool = tool({
  name: "asc_set_beta_whats_new",
  description: "Upsert the per-locale \"What to Test\" text for a TestFlight build.",
  inputSchema: z.object({
    buildId: z.string(),
    locale: z.string(),
    whatsNew: z.string().max(4000),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<{ locale?: string }>(`/v1/builds/${input.buildId}/betaBuildLocalizations`, { limit: 100 });
    const match = existing.find((l) => l.attributes?.locale === input.locale);
    if (match) {
      return await client.patch(`/v1/betaBuildLocalizations/${match.id}`, {
        data: { type: "betaBuildLocalizations", id: match.id, attributes: { whatsNew: input.whatsNew } },
      });
    }
    return await client.post("/v1/betaBuildLocalizations", {
      data: {
        type: "betaBuildLocalizations",
        attributes: { locale: input.locale, whatsNew: input.whatsNew },
        relationships: { build: { data: { type: "builds", id: input.buildId } } },
      },
    });
  },
});

export const distributeToBetaGroupsTool = tool({
  name: "asc_distribute_to_beta_groups",
  description: "Attach a build to one or more beta groups, which distributes it to the testers in those groups.",
  inputSchema: z.object({
    buildId: z.string(),
    groupIds: z.array(z.string()).min(1),
  }).strict(),
  handler: async (input, { client }) => {
    for (const gid of input.groupIds) {
      await client.post(`/v1/betaGroups/${gid}/relationships/builds`, {
        data: [{ type: "builds", id: input.buildId }],
      });
    }
    return { ok: true, buildId: input.buildId, groupIds: input.groupIds };
  },
});

export const submitForBetaReviewTool = tool({
  name: "asc_submit_for_beta_review",
  description: "Submit a build for TestFlight beta review (required for external testers).",
  inputSchema: z.object({ buildId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.post("/v1/betaAppReviewSubmissions", {
      data: {
        type: "betaAppReviewSubmissions",
        relationships: { build: { data: { type: "builds", id: input.buildId } } },
      },
    });
  },
});
