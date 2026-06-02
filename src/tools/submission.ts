import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Submission-gate extras beyond version metadata: app territory availability (where the app is sold)
 * and export-compliance encryption declarations.
 *
 * Write shapes cross-checked against the App Store Connect OpenAPI spec (round-4 audit): app availability
 * inlines `territoryAvailabilities` resources; the encryption declaration is appDescription + two crypto flags.
 */

// ── App availability (which territories the app is sold in) ──────────────────

export const getAppAvailabilityTool = tool({
  name: "asc_get_app_availability",
  description: "Read the app's territory availability (which App Store territories it's available in, and whether new territories auto-add).",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    // appAvailabilityV2 is a singleton off the app; territories live under `territoryAvailabilities`
    // (confirmed live — `availableTerritories` is not a valid relationship here). Best-effort so an
    // app with no availability record yet degrades to null rather than erroring.
    return await client.get(`/v1/apps/${input.appId}/appAvailabilityV2`, {
      query: { include: "territoryAvailabilities", "limit[territoryAvailabilities]": 200 },
    }).catch(() => ({ data: null }));
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
    // The v2 shape (per the OpenAPI spec) is NOT plain territory refs: `territoryAvailabilities` references
    // inline `territoryAvailabilities` resources, each carrying `available` + its own `territory` relationship.
    // Build them inline via placeholder ids, the same way price schedules inline their appPrices.
    const included = (territoryIds ?? []).map((tid, i) => ({
      type: "territoryAvailabilities",
      id: "${territory-availability-" + i + "}",
      attributes: { available: true },
      relationships: { territory: { data: { type: "territories", id: tid } } },
    }));
    const res = await client.post<{ data: { id: string } }>("/v2/appAvailabilities", {
      data: {
        type: "appAvailabilities",
        attributes: { availableInNewTerritories: input.availableInNewTerritories },
        relationships: {
          app: { data: { type: "apps", id: input.appId } },
          territoryAvailabilities: { data: included.map((ta) => ({ type: ta.type, id: ta.id })) },
        },
      },
      included,
    });
    return { ok: true, availabilityId: res.data.id, territories: territoryIds, availableInNewTerritories: input.availableInNewTerritories };
  },
});

// ── Export compliance (encryption declarations) ──────────────────────────────

export const listEncryptionDeclarationsTool = tool({
  name: "asc_list_encryption_declarations",
  description: "List the app's export-compliance encryption declarations (id, state, appDescription, and the cryptography flags).",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    // `sort` is rejected on this endpoint (confirmed live) — omit it.
    const decls = await client.list(`/v1/appEncryptionDeclarations`, {
      "filter[app]": input.appId,
      limit: 50,
    });
    return decls.map((d) => ({ id: d.id, ...d.attributes }));
  },
});

export const createEncryptionDeclarationTool = tool({
  name: "asc_create_encryption_declaration",
  description:
    "Create an export-compliance encryption declaration. The questionnaire is two yes/no questions plus a description: " +
    "an app that only uses standard OS/HTTPS encryption answers false to both containsProprietaryCryptography and " +
    "containsThirdPartyCryptography (that's the exempt case). availableOnFrenchStore must reflect French distribution. " +
    "Attach the result to a build with asc_assign_encryption_declaration.",
  inputSchema: z.object({
    appId: z.string(),
    appDescription: z.string().describe("Short description of how the app uses encryption (Apple requires this)."),
    containsProprietaryCryptography: z.boolean().describe("True if the app implements its own/proprietary encryption algorithms."),
    containsThirdPartyCryptography: z.boolean().describe("True if the app uses third-party encryption beyond the OS standard libraries."),
    availableOnFrenchStore: z.boolean().describe("Whether the app is distributed on the French App Store (French export law)."),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes = {
      appDescription: input.appDescription,
      containsProprietaryCryptography: input.containsProprietaryCryptography,
      containsThirdPartyCryptography: input.containsThirdPartyCryptography,
      availableOnFrenchStore: input.availableOnFrenchStore,
    };
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
