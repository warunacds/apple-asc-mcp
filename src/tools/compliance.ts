import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Submission compliance declarations: content rights and the age-rating questionnaire.
 * (App privacy / "nutrition label" data usages are a separate, larger surface — not here yet.)
 *
 * Not yet validated against live Apple traffic; marked [VERIFY] where the shape is inferred.
 */

// Content rights lives as an attribute on the app itself (not a separate resource).

export const setContentRightsTool = tool({
  name: "asc_set_content_rights",
  description:
    "Declare whether the app contains, shows, or accesses third-party content (the Content Rights question in " +
    "App Store Connect). PATCHes the app's contentRightsDeclaration. asc_get_app already reads the current value.",
  inputSchema: z.object({
    appId: z.string(),
    usesThirdPartyContent: z.boolean().describe("true → USES_THIRD_PARTY_CONTENT (you have the rights); false → DOES_NOT_USE_THIRD_PARTY_CONTENT."),
  }).strict(),
  handler: async (input, { client }) => {
    const contentRightsDeclaration = input.usesThirdPartyContent ? "USES_THIRD_PARTY_CONTENT" : "DOES_NOT_USE_THIRD_PARTY_CONTENT";
    const res = await client.patch(`/v1/apps/${input.appId}`, {
      data: { type: "apps", id: input.appId, attributes: { contentRightsDeclaration } },
    });
    return { ok: true, appId: input.appId, contentRightsDeclaration, result: res };
  },
});

// Age rating. The declaration hangs off the AppInfo: appInfo → ageRatingDeclaration → PATCH by its id.

/** Resolve the editable (PREPARE_FOR_SUBMISSION) AppInfo id for an app, falling back to the first. */
async function resolveAppInfoId(client: import("../client.js").AscClient, appId: string): Promise<string> {
  const infos = await client.list<{ state?: string }>(`/v1/apps/${appId}/appInfos`, { limit: 50, "fields[appInfos]": "state" });
  const editable = infos.find((i) => (i.attributes?.state ?? "").includes("PREPARE")) ?? infos[0];
  if (!editable) throw new Error(`No AppInfo found for app ${appId}.`);
  return editable.id;
}

const FREQUENCY = ["NONE", "INFREQUENT_OR_MILD", "FREQUENT_OR_INTENSE"] as const;
const freq = () => z.enum(FREQUENCY).optional();

// The well-established questionnaire fields. Apple overhauled age ratings in 2024–25 (new bands and
// questions); pass anything not listed here via `additionalDeclarations`.
const AGE_RATING_FIELDS = [
  "violenceCartoonOrFantasy", "violenceRealistic", "violenceRealisticProlongedGraphicOrSadistic",
  "profanityOrCrudeHumor", "matureOrSuggestiveThemes", "horrorOrFearThemes",
  "medicalOrTreatmentInformation", "alcoholTobaccoOrDrugUseOrReferences",
  "sexualContentOrNudity", "sexualContentGraphicAndNudity", "gamblingSimulated", "contests",
  "gambling", "unrestrictedWebAccess", "kidsAgeBand",
] as const;

export const getAgeRatingTool = tool({
  name: "asc_get_age_rating",
  description:
    "Read the age-rating declaration for an app (the questionnaire answers behind the App Store age band). " +
    "Resolves the editable AppInfo automatically; pass appInfoId to skip that.",
  inputSchema: z.object({
    appId: z.string(),
    appInfoId: z.string().optional().describe("Skip AppInfo resolution by passing it directly."),
  }).strict(),
  handler: async (input, { client }) => {
    const appInfoId = input.appInfoId ?? (await resolveAppInfoId(client, input.appId));
    const decl = await client.get<{ data?: { id: string; attributes?: Record<string, unknown> } | null }>(
      `/v1/appInfos/${appInfoId}/ageRatingDeclaration`,
    );
    if (!decl?.data) throw new Error(`No ageRatingDeclaration found on AppInfo ${appInfoId}.`);
    return { id: decl.data.id, appInfoId, ...decl.data.attributes };
  },
});

export const setAgeRatingTool = tool({
  name: "asc_set_age_rating",
  description:
    "Set the age-rating questionnaire for an app. Frequency questions take NONE / INFREQUENT_OR_MILD / " +
    "FREQUENT_OR_INTENSE; only the fields you pass are changed. Resolves the editable AppInfo and its declaration " +
    "automatically. Apple revised the questionnaire in 2024–25 — use additionalDeclarations for any question not " +
    "in the typed list.",
  inputSchema: z.object({
    appId: z.string(),
    appInfoId: z.string().optional().describe("Skip AppInfo resolution by passing it directly."),
    violenceCartoonOrFantasy: freq(),
    violenceRealistic: freq(),
    violenceRealisticProlongedGraphicOrSadistic: freq(),
    profanityOrCrudeHumor: freq(),
    matureOrSuggestiveThemes: freq(),
    horrorOrFearThemes: freq(),
    medicalOrTreatmentInformation: freq(),
    alcoholTobaccoOrDrugUseOrReferences: freq(),
    sexualContentOrNudity: freq(),
    sexualContentGraphicAndNudity: freq(),
    gamblingSimulated: freq(),
    contests: freq(),
    gambling: z.boolean().optional(),
    unrestrictedWebAccess: z.boolean().optional(),
    kidsAgeBand: z.enum(["FIVE_AND_UNDER", "SIX_TO_EIGHT", "NINE_TO_ELEVEN"]).nullable().optional().describe("Only for apps in the Kids category; null clears it."),
    additionalDeclarations: z.record(z.string(), z.unknown()).optional().describe("Escape hatch for questionnaire fields Apple added/renamed (the 2024–25 overhaul). Merged verbatim into the PATCH attributes."),
  }).strict(),
  handler: async (input, { client }) => {
    const appInfoId = input.appInfoId ?? (await resolveAppInfoId(client, input.appId));
    const decl = await client.get<{ data?: { id: string } | null }>(`/v1/appInfos/${appInfoId}/ageRatingDeclaration`);
    const declId = decl?.data?.id;
    if (!declId) throw new Error(`No ageRatingDeclaration found on AppInfo ${appInfoId}.`);

    const attributes: Record<string, unknown> = {};
    for (const k of AGE_RATING_FIELDS) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    // [VERIFY] questionnaire field names/values shift with Apple's age-rating revisions; additionalDeclarations
    // lets callers set fields this tool doesn't yet know about. We PATCH only what's provided.
    if (input.additionalDeclarations) Object.assign(attributes, input.additionalDeclarations);
    if (Object.keys(attributes).length === 0) {
      throw new Error("No age-rating fields provided. Pass at least one questionnaire field or additionalDeclarations.");
    }

    const res = await client.patch(`/v1/ageRatingDeclarations/${declId}`, {
      data: { type: "ageRatingDeclarations", id: declId, attributes },
    });
    return { ok: true, id: declId, appInfoId, updated: Object.keys(attributes), result: res };
  },
});
