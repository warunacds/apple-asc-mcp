import { z } from "zod";
import { tool } from "./registry.js";
import type { AppDataUsagePublishStateAttrs } from "../types.js";

/**
 * App Privacy "nutrition label" — the data-collection declaration every app must publish before
 * submission. Apple models it as tuples of (data-type category × purpose × data-protection level),
 * plus a publish step.
 *
 * Typical flows:
 *   - Collects nothing: asc_declare_no_data_collected → asc_publish_privacy.
 *   - Collects data:    asc_list_privacy_options (get ids) → asc_add_data_usage per row → asc_publish_privacy.
 *
 * ⚠ KNOWN-BROKEN (confirmed live): the reference endpoints used here — `appDataUsageCategories`,
 * `appDataUsagePurposes`, `appDataUsageDataProtections` — all return 404 "does not exist", and the app's
 * own relationship map has no `appDataUsage*` relationship. So this whole domain targets endpoints that
 * aren't in the public App Store Connect API (App Privacy may be UI-only, or use different resources).
 * These tools do NOT work as written and need the correct resource model before they're usable.
 */

const NO_DATA_COLLECTED = "DATA_NOT_COLLECTED";

export const listPrivacyOptionsTool = tool({
  name: "asc_list_privacy_options",
  description:
    "List the reference options for the App Privacy label: data-type categories, purposes, and data-protection " +
    "levels (DATA_USED_TO_TRACK_YOU / DATA_LINKED_TO_YOU / DATA_NOT_LINKED_TO_YOU / DATA_NOT_COLLECTED). " +
    "Use the returned ids with asc_add_data_usage.",
  inputSchema: z.object({}).strict(),
  handler: async (_input, { client }) => {
    // KNOWN-BROKEN: confirmed live that all three of these reference endpoints 404 ("does not exist").
    // The App Privacy resource model here is wrong — these names aren't in the public API. Fetched
    // best-effort so the tool returns the per-list errors (for diagnosis) instead of hard-failing.
    const shape = (rs: { id: string; attributes?: Record<string, unknown> }[]) => rs.map((r) => ({ id: r.id, ...r.attributes }));
    const fetch1 = (path: string) => client.list<{ deleted?: boolean }>(path, { limit: 200 }).then(shape).catch((e) => ({ error: String((e as Error).message).slice(0, 200) }));
    const [categories, purposes, dataProtections] = await Promise.all([
      fetch1("/v1/appDataUsageCategories"),
      fetch1("/v1/appDataUsagePurposes"),
      fetch1("/v1/appDataUsageDataProtections"),
    ]);
    return { categories, purposes, dataProtections };
  },
});

export const getPrivacyDetailsTool = tool({
  name: "asc_get_privacy_details",
  description:
    "Read an app's current privacy declarations (appDataUsages) and whether the label is published. " +
    "Each usage links a category, purpose, and data-protection level.",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const usages = await client
      .get(`/v1/apps/${input.appId}/appDataUsages`, {
        query: { include: "category,purpose,dataProtection", limit: 200 },
      })
      .catch(() => null);
    // Publish state is a singleton sub-resource; best-effort so a missing one degrades to null.
    const publishState = await client
      .get<{ data?: { id: string; attributes?: AppDataUsagePublishStateAttrs } | null }>(`/v1/apps/${input.appId}/appDataUsagesPublishState`)
      .catch(() => null);
    return {
      appId: input.appId,
      published: publishState?.data?.attributes?.published ?? null,
      publishStateId: publishState?.data?.id ?? null,
      dataUsages: usages,
    };
  },
});

export const addDataUsageTool = tool({
  name: "asc_add_data_usage",
  description:
    "Declare one data-collection row on the App Privacy label: a (category, purpose, data-protection) tuple. " +
    "Get the ids from asc_list_privacy_options. Omit purposeId only for protection-only rows (e.g. tracking). " +
    "Call once per row, then asc_publish_privacy. For an app that collects nothing, use asc_declare_no_data_collected instead.",
  inputSchema: z.object({
    appId: z.string(),
    categoryId: z.string().describe("appDataUsageCategory id from asc_list_privacy_options."),
    dataProtectionId: z.string().describe("appDataUsageDataProtection id (e.g. the DATA_LINKED_TO_YOU option)."),
    purposeId: z.string().optional().describe("appDataUsagePurpose id. Required for collected data; omit for protection-only rows."),
  }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] relationship key names (category / purpose / dataProtection / app) and which combos
    // are required per protection level.
    const relationships: Record<string, unknown> = {
      app: { data: { type: "apps", id: input.appId } },
      category: { data: { type: "appDataUsageCategories", id: input.categoryId } },
      dataProtection: { data: { type: "appDataUsageDataProtections", id: input.dataProtectionId } },
    };
    if (input.purposeId) relationships.purpose = { data: { type: "appDataUsagePurposes", id: input.purposeId } };
    const res = await client.post<{ data: { id: string } }>("/v1/appDataUsages", {
      data: { type: "appDataUsages", relationships },
    });
    return { ok: true, dataUsageId: res.data.id, appId: input.appId };
  },
});

export const removeDataUsageTool = tool({
  name: "asc_remove_data_usage",
  description: "Remove a single privacy declaration (appDataUsage) by id. Find ids via asc_get_privacy_details.",
  inputSchema: z.object({ dataUsageId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/appDataUsages/${input.dataUsageId}`);
    return { ok: true, dataUsageId: input.dataUsageId };
  },
});

export const declareNoDataCollectedTool = tool({
  name: "asc_declare_no_data_collected",
  description:
    "Shortcut for an app that collects no data: creates the single DATA_NOT_COLLECTED declaration. " +
    "Follow with asc_publish_privacy. Resolves the protection id automatically.",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const protections = await client.list<{ deleted?: boolean }>("/v1/appDataUsageDataProtections", { limit: 200 });
    // The DATA_NOT_COLLECTED option's id; [VERIFY] whether the id equals the constant or is opaque.
    const match = protections.find((p) => p.id === NO_DATA_COLLECTED) ?? protections.find((p) => JSON.stringify(p.attributes ?? {}).includes(NO_DATA_COLLECTED));
    if (!match) {
      throw new Error(`Could not find the ${NO_DATA_COLLECTED} data-protection option. Inspect asc_list_privacy_options and pass its id via asc_add_data_usage instead.`);
    }
    // [VERIFY] "no data collected" is a single appDataUsage carrying only the DATA_NOT_COLLECTED protection (no category/purpose).
    const res = await client.post<{ data: { id: string } }>("/v1/appDataUsages", {
      data: {
        type: "appDataUsages",
        relationships: {
          app: { data: { type: "apps", id: input.appId } },
          dataProtection: { data: { type: "appDataUsageDataProtections", id: match.id } },
        },
      },
    });
    return { ok: true, dataUsageId: res.data.id, appId: input.appId, note: "Now call asc_publish_privacy to publish the label." };
  },
});

export const publishPrivacyTool = tool({
  name: "asc_publish_privacy",
  description:
    "Publish the App Privacy label (PATCH appDataUsagesPublishState published=true). Apple rejects this if the " +
    "declaration is incomplete — the error names what's missing. Set published=false to unpublish/return to draft.",
  inputSchema: z.object({
    appId: z.string(),
    published: z.boolean().default(true),
  }).strict(),
  handler: async (input, { client }) => {
    // The publish state is a singleton; fetch its id, then PATCH it.
    const current = await client.get<{ data?: { id: string } | null }>(`/v1/apps/${input.appId}/appDataUsagesPublishState`);
    const id = current?.data?.id;
    if (!id) throw new Error(`No appDataUsagesPublishState found for app ${input.appId}.`);
    // [VERIFY] attribute name `published` and that PATCH is the publish trigger.
    const res = await client.patch(`/v1/appDataUsagesPublishStates/${id}`, {
      data: { type: "appDataUsagesPublishStates", id, attributes: { published: input.published } },
    });
    return { ok: true, appId: input.appId, published: input.published, result: res };
  },
});
