import { z } from "zod";
import { tool } from "./registry.js";

/**
 * TestFlight beta groups & beta testers.
 *
 * Beta groups bundle testers and grant them access to builds; beta testers are the individual
 * people invited to test. The two are linked through JSON:API to-many relationship endpoints
 * (/relationships/betaTesters, /relationships/betaGroups, /relationships/builds, /relationships/apps).
 *
 * Several relationship removals issue DELETE with a JSON:API body (an array of resource identifiers).
 * No other tool in this repo exercises DELETE-with-body; see [VERIFY] on those handlers — if Apple
 * rejects the body, fall back to per-id DELETEs.
 *
 * Not validated against live Apple traffic; request/response shapes are inferred from the
 * App Store Connect API and marked [VERIFY] where unconfirmed.
 */

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

// ── Beta Groups ─────────────────────────────────────────────────────────────

export const createBetaGroupTool = tool({
  name: "asc_create_beta_group",
  description: "Create a TestFlight beta group for an app. Only name is required; the booleans default to false at Apple.",
  inputSchema: z.object({
    appId: z.string(),
    name: z.string(),
    isInternalGroup: z.boolean().optional(),
    hasAccessToAllBuilds: z.boolean().optional(),
    publicLinkEnabled: z.boolean().optional(),
    feedbackEnabled: z.boolean().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = { name: input.name };
    for (const k of ["isInternalGroup", "hasAccessToAllBuilds", "publicLinkEnabled", "feedbackEnabled"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    return await client.post("/v1/betaGroups", {
      data: {
        type: "betaGroups",
        attributes,
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    });
  },
});

export const updateBetaGroupTool = tool({
  name: "asc_update_beta_group",
  description: "Update a beta group's name, public link, or feedback settings. Only the fields you pass change.",
  inputSchema: z.object({
    betaGroupId: z.string(),
    name: z.string().optional(),
    publicLinkEnabled: z.boolean().optional(),
    publicLinkLimit: z.number().int().optional(),
    feedbackEnabled: z.boolean().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {};
    for (const k of ["name", "publicLinkEnabled", "publicLinkLimit", "feedbackEnabled"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    if (Object.keys(attributes).length === 0) throw new Error("Provide at least one field to update.");
    return await client.patch(`/v1/betaGroups/${input.betaGroupId}`, {
      data: { type: "betaGroups", id: input.betaGroupId, attributes },
    });
  },
});

export const deleteBetaGroupTool = tool({
  name: "asc_delete_beta_group",
  description: "Delete a TestFlight beta group.",
  inputSchema: z.object({ betaGroupId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/betaGroups/${input.betaGroupId}`);
    return { ok: true, betaGroupId: input.betaGroupId };
  },
});

export const addTestersToBetaGroupTool = tool({
  name: "asc_add_testers_to_beta_group",
  description: "Add one or more beta testers to a beta group.",
  inputSchema: z.object({
    betaGroupId: z.string(),
    testerIds: z.array(z.string()).min(1),
  }).strict(),
  handler: async (input, { client }) => {
    await client.post(`/v1/betaGroups/${input.betaGroupId}/relationships/betaTesters`, {
      data: input.testerIds.map((id) => ({ type: "betaTesters", id })),
    });
    return { ok: true, betaGroupId: input.betaGroupId, testerIds: input.testerIds };
  },
});

export const removeTestersFromBetaGroupTool = tool({
  name: "asc_remove_testers_from_beta_group",
  description: "Remove one or more beta testers from a beta group.",
  inputSchema: z.object({
    betaGroupId: z.string(),
    testerIds: z.array(z.string()).min(1),
  }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] DELETE-with-body: no other tool in this repo sends a DELETE body. Unprovable
    // offline; on first live call confirm Apple accepts the to-many DELETE body, else fall
    // back to issuing one DELETE per id.
    await client.delete(`/v1/betaGroups/${input.betaGroupId}/relationships/betaTesters`, {
      body: { data: input.testerIds.map((id) => ({ type: "betaTesters", id })) },
    });
    return { ok: true, betaGroupId: input.betaGroupId, testerIds: input.testerIds };
  },
});

export const listBetaGroupTestersTool = tool({
  name: "asc_list_beta_group_testers",
  description: "List the beta testers in a beta group.",
  inputSchema: z.object({
    betaGroupId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const testers = await client.list(`/v1/betaGroups/${input.betaGroupId}/betaTesters`, { limit: input.limit ?? 100 });
    return testers.map((t) => ({ id: t.id, ...t.attributes }));
  },
});

export const removeBuildsFromBetaGroupTool = tool({
  name: "asc_remove_builds_from_beta_group",
  description: "Remove one or more builds from a beta group (inverse of asc_distribute_to_beta_groups).",
  inputSchema: z.object({
    betaGroupId: z.string(),
    buildIds: z.array(z.string()).min(1),
  }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] DELETE-with-body: no other tool in this repo sends a DELETE body. Confirm Apple
    // accepts the to-many DELETE body on first live call, else fall back to per-id DELETEs.
    await client.delete(`/v1/betaGroups/${input.betaGroupId}/relationships/builds`, {
      body: { data: input.buildIds.map((id) => ({ type: "builds", id })) },
    });
    return { ok: true, betaGroupId: input.betaGroupId, buildIds: input.buildIds };
  },
});

// ── Beta Testers ────────────────────────────────────────────────────────────

export const listBetaTestersTool = tool({
  name: "asc_list_beta_testers",
  description: "List TestFlight beta testers, optionally scoped to a single app.",
  inputSchema: z.object({
    appId: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] the app filter key is filter[apps] (plural), not filter[app].
    const q: Record<string, string | number | undefined> = { limit: input.limit ?? 100 };
    if (input.appId) q["filter[apps]"] = input.appId;
    const testers = await client.list("/v1/betaTesters", q);
    return testers.map((t) => ({ id: t.id, ...t.attributes }));
  },
});

export const searchBetaTestersTool = tool({
  name: "asc_search_beta_testers",
  description: "Find a beta tester by exact email address (no partial matching). Optionally scope to an app.",
  inputSchema: z.object({
    email: z.string(),
    appId: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const q: Record<string, string | undefined> = { "filter[email]": input.email };
    if (input.appId) q["filter[apps]"] = input.appId; // [VERIFY] plural filter key.
    const testers = await client.list("/v1/betaTesters", q);
    return testers.map((t) => ({ id: t.id, ...t.attributes }));
  },
});

export const getBetaTesterTool = tool({
  name: "asc_get_beta_tester",
  description: "Get a single beta tester. Pass include to sideload related apps, betaGroups, and/or builds.",
  inputSchema: z.object({
    betaTesterId: z.string(),
    // [VERIFY] raw.json lists apps,betaGroups,builds as accepted include members, but only
    // apps+betaGroups are confirmed in the response; "builds" is unconfirmed (an unsupported
    // include yields an actionable Apple 400).
    include: z.array(z.enum(["apps", "betaGroups", "builds"])).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const query: Record<string, string | string[]> = {};
    if (input.include) query.include = input.include;
    return await client.get(`/v1/betaTesters/${input.betaTesterId}`, { query });
  },
});

export const createBetaTesterTool = tool({
  name: "asc_create_beta_tester",
  description: "Invite a new beta tester by email and add them to one or more beta groups.",
  inputSchema: z.object({
    email: z.string(),
    groupIds: z.array(z.string()).min(1),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    return await client.post("/v1/betaTesters", {
      data: {
        type: "betaTesters",
        attributes: {
          email: input.email,
          firstName: input.firstName ?? null,
          lastName: input.lastName ?? null,
        },
        relationships: {
          betaGroups: { data: input.groupIds.map((id) => ({ type: "betaGroups", id })) },
        },
      },
    });
  },
});

export const deleteBetaTesterTool = tool({
  name: "asc_delete_beta_tester",
  description: "Delete a beta tester entirely, removing them from all groups and apps.",
  inputSchema: z.object({ betaTesterId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/betaTesters/${input.betaTesterId}`);
    return { ok: true, betaTesterId: input.betaTesterId };
  },
});

export const listBetaTesterAppsTool = tool({
  name: "asc_list_beta_tester_apps",
  description: "List the apps a beta tester has access to.",
  inputSchema: z.object({
    betaTesterId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const apps = await client.list(`/v1/betaTesters/${input.betaTesterId}/apps`, { limit: input.limit ?? 100 });
    return apps.map((a) => ({ id: a.id, ...a.attributes }));
  },
});

export const sendBetaTesterInvitationTool = tool({
  name: "asc_send_beta_tester_invitation",
  description: "Send or resend a TestFlight invitation to a beta tester for a specific app.",
  inputSchema: z.object({
    betaTesterId: z.string(),
    appId: z.string(),
  }).strict(),
  handler: async (input, { client }) => {
    return await client.post("/v1/betaTesterInvitations", {
      data: {
        type: "betaTesterInvitations",
        relationships: {
          betaTester: { data: { type: "betaTesters", id: input.betaTesterId } },
          app: { data: { type: "apps", id: input.appId } },
        },
      },
    });
  },
});

export const addBetaTesterToGroupsTool = tool({
  name: "asc_add_beta_tester_to_groups",
  description: "Add a beta tester to one or more beta groups.",
  inputSchema: z.object({
    betaTesterId: z.string(),
    groupIds: z.array(z.string()).min(1),
  }).strict(),
  handler: async (input, { client }) => {
    await client.post(`/v1/betaTesters/${input.betaTesterId}/relationships/betaGroups`, {
      data: input.groupIds.map((id) => ({ type: "betaGroups", id })),
    });
    return { ok: true, betaTesterId: input.betaTesterId, groupIds: input.groupIds };
  },
});

export const removeBetaTesterFromGroupsTool = tool({
  name: "asc_remove_beta_tester_from_groups",
  description: "Remove a beta tester from one or more beta groups.",
  inputSchema: z.object({
    betaTesterId: z.string(),
    groupIds: z.array(z.string()).min(1),
  }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] DELETE-with-body: no other tool in this repo sends a DELETE body. Confirm Apple
    // accepts the to-many DELETE body on first live call, else fall back to per-id DELETEs.
    await client.delete(`/v1/betaTesters/${input.betaTesterId}/relationships/betaGroups`, {
      body: { data: input.groupIds.map((id) => ({ type: "betaGroups", id })) },
    });
    return { ok: true, betaTesterId: input.betaTesterId, groupIds: input.groupIds };
  },
});

export const addBetaTesterToBuildsTool = tool({
  name: "asc_add_beta_tester_to_builds",
  description: "Assign one or more builds to a beta tester for individual testing.",
  inputSchema: z.object({
    betaTesterId: z.string(),
    buildIds: z.array(z.string()).min(1),
  }).strict(),
  handler: async (input, { client }) => {
    await client.post(`/v1/betaTesters/${input.betaTesterId}/relationships/builds`, {
      data: input.buildIds.map((id) => ({ type: "builds", id })),
    });
    return { ok: true, betaTesterId: input.betaTesterId, buildIds: input.buildIds };
  },
});

export const removeBetaTesterFromBuildsTool = tool({
  name: "asc_remove_beta_tester_from_builds",
  description: "Remove a beta tester's access to one or more individually-assigned builds.",
  inputSchema: z.object({
    betaTesterId: z.string(),
    buildIds: z.array(z.string()).min(1),
  }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] DELETE-with-body: no other tool in this repo sends a DELETE body. Confirm Apple
    // accepts the to-many DELETE body on first live call, else fall back to per-id DELETEs.
    await client.delete(`/v1/betaTesters/${input.betaTesterId}/relationships/builds`, {
      body: { data: input.buildIds.map((id) => ({ type: "builds", id })) },
    });
    return { ok: true, betaTesterId: input.betaTesterId, buildIds: input.buildIds };
  },
});

export const removeBetaTesterFromAppTool = tool({
  name: "asc_remove_beta_tester_from_app",
  description: "Revoke a beta tester's access to an app entirely.",
  inputSchema: z.object({
    betaTesterId: z.string(),
    appId: z.string(),
  }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] DELETE-with-body: single app id wrapped in the JSON:API to-many array. No other
    // tool in this repo sends a DELETE body; confirm Apple accepts it on first live call.
    await client.delete(`/v1/betaTesters/${input.betaTesterId}/relationships/apps`, {
      body: { data: [{ type: "apps", id: input.appId }] },
    });
    return { ok: true, betaTesterId: input.betaTesterId, appId: input.appId };
  },
});
