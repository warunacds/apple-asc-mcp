import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Submission-gate extras beyond version metadata: app territory availability (where the app is sold)
 * and export-compliance encryption declarations.
 *
 * Not validated against live Apple traffic; endpoint/shape details inferred and marked [VERIFY].
 */

// ── App availability (which territories the app is sold in) ──────────────────

export const getAppAvailabilityTool = tool({
  name: "asc_get_app_availability",
  description: "Read the app's territory availability (which App Store territories it's available in, and whether new territories auto-add).",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] the current model is appAvailabilityV2 (a singleton off the app); availableTerritories sideloaded.
    return await client.get(`/v1/apps/${input.appId}/appAvailabilityV2`, {
      query: { include: "availableTerritories", "limit[availableTerritories]": 200 },
    });
  },
});

export const setAppAvailabilityTool = tool({
  name: "asc_set_app_availability",
  description:
    "Set the territories where the app is available for sale. Pass territory codes (e.g. [\"USA\",\"GBR\"]) or " +
    "availableInAllTerritories=true. availableInNewTerritories controls whether Apple auto-adds future territories.",
  inputSchema: z.object({
    appId: z.string(),
    territories: z.array(z.string()).optional().describe("Territory codes. Required unless availableInAllTerritories is true."),
    availableInAllTerritories: z.boolean().optional(),
    availableInNewTerritories: z.boolean().default(true),
  }).strict().refine(
    (v) => v.availableInAllTerritories || (v.territories?.length ?? 0) > 0,
    { message: "Provide territories[] or availableInAllTerritories=true." },
  ),
  handler: async (input, { client }) => {
    let territoryIds = input.territories;
    if (input.availableInAllTerritories && !territoryIds) {
      const all = await client.list("/v1/territories", { limit: 200 });
      territoryIds = all.map((t) => t.id);
    }
    // [VERIFY] v2 create endpoint + relationship shape (mirrors inAppPurchaseAvailabilities / subscriptionAvailabilities).
    const res = await client.post<{ data: { id: string } }>("/v2/appAvailabilities", {
      data: {
        type: "appAvailabilities",
        attributes: { availableInNewTerritories: input.availableInNewTerritories },
        relationships: {
          app: { data: { type: "apps", id: input.appId } },
          availableTerritories: { data: (territoryIds ?? []).map((id) => ({ type: "territories", id })) },
        },
      },
    });
    return { ok: true, availabilityId: res.data.id, territories: territoryIds, availableInNewTerritories: input.availableInNewTerritories };
  },
});

// ── Export compliance (encryption declarations) ──────────────────────────────

export const listEncryptionDeclarationsTool = tool({
  name: "asc_list_encryption_declarations",
  description: "List the app's export-compliance encryption declarations (id, state, and the usesEncryption/exempt flags).",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const decls = await client.list(`/v1/appEncryptionDeclarations`, {
      "filter[app]": input.appId,
      limit: 50,
      sort: "-createdDate",
    });
    return decls.map((d) => ({ id: d.id, ...d.attributes }));
  },
});

export const createEncryptionDeclarationTool = tool({
  name: "asc_create_encryption_declaration",
  description:
    "Create an export-compliance encryption declaration. Most apps that only use standard/exempt encryption (HTTPS) " +
    "set usesEncryption=true + exempt=true. Apps using non-exempt encryption may need to provide export documents " +
    "in App Store Connect. Attach the result to a build with asc_assign_encryption_declaration.",
  inputSchema: z.object({
    appId: z.string(),
    usesEncryption: z.boolean(),
    exempt: z.boolean().optional().describe("True if the encryption qualifies for an export exemption (e.g. standard HTTPS)."),
    containsProprietaryCryptography: z.boolean().optional(),
    containsThirdPartyCryptography: z.boolean().optional(),
    availableOnFrenchStore: z.boolean().optional().describe("Required by French export law if distributing in France."),
    platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = { usesEncryption: input.usesEncryption };
    for (const k of ["exempt", "containsProprietaryCryptography", "containsThirdPartyCryptography", "availableOnFrenchStore", "platform"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/appEncryptionDeclarations", {
      data: { type: "appEncryptionDeclarations", attributes, relationships: { app: { data: { type: "apps", id: input.appId } } } },
    });
    return { ok: true, declarationId: res.data.id, ...res.data.attributes };
  },
});

export const assignEncryptionDeclarationTool = tool({
  name: "asc_assign_encryption_declaration",
  description: "Attach an existing encryption declaration to a build (sets the build's appEncryptionDeclaration relationship).",
  inputSchema: z.object({
    buildId: z.string(),
    declarationId: z.string(),
  }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] relationship endpoint on builds.
    await client.patch(`/v1/builds/${input.buildId}/relationships/appEncryptionDeclaration`, {
      data: { type: "appEncryptionDeclarations", id: input.declarationId },
    });
    return { ok: true, buildId: input.buildId, declarationId: input.declarationId };
  },
});
