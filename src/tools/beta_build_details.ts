import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Build-scoped TestFlight configuration (buildBetaDetails domain).
 *
 * Covers a single build's beta wiring: its beta detail (auto-notify + internal/external build
 * state), its per-locale "What to Test" localizations, the groups and individual testers attached
 * to it, and the "new build available" notification. This sits alongside the app-scoped beta tools
 * in testflight.ts (asc_list_beta_groups, asc_distribute_to_beta_groups, asc_set_beta_whats_new,
 * asc_submit_for_beta_review), which remain the canonical tools for their respective jobs.
 *
 * The whole server is unvalidated against live Apple traffic; non-trivial JSON:API shapes are
 * marked [VERIFY] inline.
 */

// internalBuildState: states a build moves through for internal TestFlight testing.
const INTERNAL_BUILD_STATES = [
  "PROCESSING",
  "PROCESSING_EXCEPTION",
  "MISSING_EXPORT_COMPLIANCE",
  "READY_FOR_BETA_TESTING",
  "IN_BETA_TESTING",
  "EXPIRED",
  "IN_EXPORT_COMPLIANCE_REVIEW",
] as const;

// externalBuildState: the internal set plus the beta-review states that only apply to external testing.
const EXTERNAL_BUILD_STATES = [
  "PROCESSING",
  "PROCESSING_EXCEPTION",
  "MISSING_EXPORT_COMPLIANCE",
  "READY_FOR_BETA_TESTING",
  "IN_BETA_TESTING",
  "EXPIRED",
  "READY_FOR_BETA_SUBMISSION",
  "WAITING_FOR_BETA_REVIEW",
  "IN_BETA_REVIEW",
  "BETA_REJECTED",
  "BETA_APPROVED",
  "NOT_APPLICABLE",
  "IN_EXPORT_COMPLIANCE_REVIEW",
] as const;

export const getBuildBetaDetailTool = tool({
  name: "asc_get_build_beta_detail",
  description:
    "Get a build's TestFlight beta detail (autoNotifyEnabled, internalBuildState, externalBuildState). " +
    "There is no direct relationship endpoint, so this dereferences in two steps: read the build's " +
    "buildBetaDetail relationship id, then fetch that resource. Returns { buildId, betaDetail: null } if " +
    "the build has no beta detail yet.",
  inputSchema: z.object({ buildId: z.string() }).strict(),
  handler: async (input, { client }) => {
    // Step 1: read the build to learn its buildBetaDetail relationship id.
    // [VERIFY] the relationship key on the build resource is "buildBetaDetail".
    const build = await client.getOne<Record<string, unknown>>(`/v1/builds/${input.buildId}`, {
      include: "buildBetaDetail",
    }) as { id: string; relationships?: { buildBetaDetail?: { data?: { id: string } | null } } };
    const detailId = build.relationships?.buildBetaDetail?.data?.id;
    if (!detailId) return { buildId: input.buildId, betaDetail: null };
    // Step 2: fetch the beta detail itself (raw JSON:API envelope, per single-get convention).
    return await client.get(`/v1/buildBetaDetails/${detailId}`, { query: { include: "build" } });
  },
});

export const updateBuildBetaDetailTool = tool({
  name: "asc_update_build_beta_detail",
  description:
    "Update a build's beta detail: autoNotifyEnabled (auto-notify testers when the build is approved) and/or " +
    "the internal/external build state. Pass the betaDetailId from asc_get_build_beta_detail. At least one " +
    "field is required.",
  inputSchema: z.object({
    betaDetailId: z.string(),
    autoNotifyEnabled: z.boolean().optional(),
    internalBuildState: z.enum(INTERNAL_BUILD_STATES).optional(),
    externalBuildState: z.enum(EXTERNAL_BUILD_STATES).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {};
    for (const k of ["autoNotifyEnabled", "internalBuildState", "externalBuildState"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    if (Object.keys(attributes).length === 0) throw new Error("Pass at least one field to update.");
    return await client.patch(`/v1/buildBetaDetails/${input.betaDetailId}`, {
      data: { type: "buildBetaDetails", id: input.betaDetailId, attributes },
    });
  },
});

export const setBuildBetaLocalizationTool = tool({
  name: "asc_set_build_beta_localization",
  description:
    "Upsert the full per-locale TestFlight localization for a build: whatsNew (\"What to Test\"), feedbackEmail, " +
    "marketingUrl, privacyPolicyUrl, tvOsPrivacyPolicy. Creates the localization if the locale is missing, " +
    "otherwise PATCHes it. For whatsNew-only edits, asc_set_beta_whats_new is simpler.",
  inputSchema: z.object({
    buildId: z.string(),
    locale: z.string().describe("e.g. en-US, ja, de-DE."),
    whatsNew: z.string().max(4000).optional().describe("\"What to Test\" text (max 4000 chars)."),
    feedbackEmail: z.string().optional(),
    marketingUrl: z.string().optional(),
    privacyPolicyUrl: z.string().optional(),
    tvOsPrivacyPolicy: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<{ locale?: string }>(`/v1/builds/${input.buildId}/betaBuildLocalizations`, { limit: 200 });
    const match = existing.find((l) => l.attributes?.locale === input.locale);
    const attributes: Record<string, unknown> = {};
    for (const k of ["whatsNew", "feedbackEmail", "marketingUrl", "privacyPolicyUrl", "tvOsPrivacyPolicy"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    if (match) {
      const res = await client.patch<{ data: { id: string; attributes?: Record<string, unknown> } }>(
        `/v1/betaBuildLocalizations/${match.id}`,
        { data: { type: "betaBuildLocalizations", id: match.id, attributes } },
      );
      return { id: match.id, action: "updated", ...res.data.attributes };
    }
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/betaBuildLocalizations", {
      data: {
        type: "betaBuildLocalizations",
        attributes: { locale: input.locale, ...attributes },
        relationships: { build: { data: { type: "builds", id: input.buildId } } },
      },
    });
    return { id: res.data.id, action: "created", ...res.data.attributes };
  },
});

export const listBuildBetaLocalizationsTool = tool({
  name: "asc_list_build_beta_localizations",
  description: "List a build's per-locale TestFlight localizations (locale, whatsNew, feedbackEmail, marketingUrl, privacyPolicyUrl).",
  inputSchema: z.object({
    buildId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const rows = await client.list(`/v1/builds/${input.buildId}/betaBuildLocalizations`, {
      limit: input.limit ?? 100,
      "fields[betaBuildLocalizations]": "locale,whatsNew,feedbackEmail,marketingUrl,privacyPolicyUrl,tvOsPrivacyPolicy",
    });
    return rows.map((r) => ({ id: r.id, ...r.attributes }));
  },
});

export const listBetaGroupsForBuildTool = tool({
  name: "asc_list_beta_groups_for_build",
  description:
    "List the TestFlight beta groups that have access to a specific build (uses filter[builds]). " +
    "This is build-scoped; asc_list_beta_groups is app-scoped.",
  inputSchema: z.object({
    buildId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const rows = await client.list("/v1/betaGroups", {
      "filter[builds]": input.buildId,
      limit: input.limit ?? 100,
      "fields[betaGroups]": "name,isInternalGroup,publicLinkEnabled,publicLink,hasAccessToAllBuilds,feedbackEnabled",
    });
    return rows.map((r) => ({ id: r.id, ...r.attributes }));
  },
});

export const addBuildToBetaGroupsTool = tool({
  name: "asc_add_build_to_beta_groups",
  description:
    "Add one build to multiple beta groups in a single request (POST /v1/builds/:id/relationships/betaGroups). " +
    "asc_distribute_to_beta_groups does the inverse (one group at a time) — either works for distribution.",
  inputSchema: z.object({
    buildId: z.string(),
    groupIds: z.array(z.string()).min(1),
  }).strict(),
  handler: async (input, { client }) => {
    await client.post(`/v1/builds/${input.buildId}/relationships/betaGroups`, {
      data: input.groupIds.map((id) => ({ type: "betaGroups", id })),
    });
    return { ok: true, buildId: input.buildId, groupIds: input.groupIds };
  },
});

export const addTestersToBuildTool = tool({
  name: "asc_add_testers_to_build",
  description: "Add individual beta testers to a build for direct testing access (no group required).",
  inputSchema: z.object({
    buildId: z.string(),
    testerIds: z.array(z.string()).min(1),
  }).strict(),
  handler: async (input, { client }) => {
    await client.post(`/v1/builds/${input.buildId}/relationships/individualTesters`, {
      data: input.testerIds.map((id) => ({ type: "betaTesters", id })),
    });
    return { ok: true, buildId: input.buildId, testerIds: input.testerIds };
  },
});

export const removeTestersFromBuildTool = tool({
  name: "asc_remove_testers_from_build",
  description: "Remove individual beta testers from a build, revoking their direct testing access.",
  inputSchema: z.object({
    buildId: z.string(),
    testerIds: z.array(z.string()).min(1),
  }).strict(),
  handler: async (input, { client }) => {
    // DELETE with a JSON:API to-many body. [VERIFY] No existing tool exercises DELETE-with-body;
    // the client serializes opts.body for any method, but this path is unconfirmed against live
    // Apple traffic — if rejected, fall back to per-id DELETEs.
    await client.delete(`/v1/builds/${input.buildId}/relationships/individualTesters`, {
      body: { data: input.testerIds.map((id) => ({ type: "betaTesters", id })) },
    });
    return { ok: true, buildId: input.buildId, testerIds: input.testerIds };
  },
});

export const listBuildIndividualTestersTool = tool({
  name: "asc_list_build_individual_testers",
  description: "List the individual beta testers assigned to a build (those added directly, outside any group).",
  inputSchema: z.object({
    buildId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const rows = await client.list(`/v1/builds/${input.buildId}/individualTesters`, {
      limit: input.limit ?? 100,
      "fields[betaTesters]": "firstName,lastName,email,inviteType,state",
    });
    return rows.map((r) => ({ id: r.id, ...r.attributes }));
  },
});

export const sendBuildBetaNotificationTool = tool({
  name: "asc_send_build_beta_notification",
  description: "Notify all testers of a build that a new build is available (POST /v1/betaBuildNotifications).",
  inputSchema: z.object({ buildId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.post("/v1/betaBuildNotifications", {
      data: { type: "betaBuildNotifications", relationships: { build: { data: { type: "builds", id: input.buildId } } } },
    });
    return { ok: true, buildId: input.buildId };
  },
});
