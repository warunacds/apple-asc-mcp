import { z } from "zod";
import { tool } from "./registry.js";
import type { AppStoreVersionAttrs, VersionLocAttrs } from "../types.js";

export const createVersionTool = tool({
  name: "asc_create_version",
  description: "Create a new App Store Version (release record) for an app. Required: appId, versionString, platform. Optionally attach a build immediately.",
  inputSchema: z.object({
    appId: z.string(),
    versionString: z.string().describe("e.g. \"1.4.0\""),
    platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
    copyright: z.string().optional(),
    releaseType: z.enum(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"]).optional(),
    earliestReleaseDate: z.string().optional().describe("ISO-8601, only valid with releaseType=SCHEDULED."),
    buildId: z.string().optional().describe("Optionally attach a build at creation. Build must be in VALID processing state."),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {
      versionString: input.versionString,
      platform: input.platform,
    };
    if (input.copyright) attributes.copyright = input.copyright;
    if (input.releaseType) attributes.releaseType = input.releaseType;
    if (input.earliestReleaseDate) attributes.earliestReleaseDate = input.earliestReleaseDate;
    const relationships: Record<string, unknown> = {
      app: { data: { type: "apps", id: input.appId } },
    };
    if (input.buildId) relationships.build = { data: { type: "builds", id: input.buildId } };

    const res = await client.post<{ data: { id: string; attributes: AppStoreVersionAttrs } }>("/v1/appStoreVersions", {
      data: { type: "appStoreVersions", attributes, relationships },
    });
    return { id: res.data.id, ...res.data.attributes };
  },
});

export const updateVersionTool = tool({
  name: "asc_update_version",
  description: "Update editable fields on an App Store Version (versionString, copyright, releaseType, earliestReleaseDate, downloadable). Only allowed in editable states.",
  inputSchema: z.object({
    versionId: z.string(),
    versionString: z.string().optional(),
    copyright: z.string().optional(),
    releaseType: z.enum(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"]).optional(),
    earliestReleaseDate: z.string().nullable().optional(),
    downloadable: z.boolean().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {};
    for (const k of ["versionString", "copyright", "releaseType", "earliestReleaseDate", "downloadable"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    const res = await client.patch(`/v1/appStoreVersions/${input.versionId}`, {
      data: { type: "appStoreVersions", id: input.versionId, attributes },
    });
    return res;
  },
});

export const attachBuildTool = tool({
  name: "asc_attach_build_to_version",
  description: "Attach (or swap) a build to an App Store Version. Build must be in VALID processing state. Allowed while version is in PREPARE_FOR_SUBMISSION or after rejection.",
  inputSchema: z.object({
    versionId: z.string(),
    buildId: z.string(),
  }).strict(),
  handler: async (input, { client }) => {
    await client.patch(`/v1/appStoreVersions/${input.versionId}/relationships/build`, {
      data: { type: "builds", id: input.buildId },
    });
    return { ok: true, versionId: input.versionId, buildId: input.buildId };
  },
});

export const setVersionLocalizationTool = tool({
  name: "asc_set_version_localization",
  description: "Upsert per-locale marketing copy on a version (description, keywords, whatsNew, promotionalText, marketingUrl, supportUrl). Creates the localization if missing, otherwise PATCHes the existing one.",
  inputSchema: z.object({
    versionId: z.string(),
    locale: z.string().describe("e.g. en-US, ja, de-DE"),
    description: z.string().max(4000).optional(),
    keywords: z.string().max(100).optional().describe("Comma-separated, total ≤100 chars."),
    promotionalText: z.string().max(170).optional(),
    whatsNew: z.string().max(4000).optional(),
    marketingUrl: z.string().url().max(255).optional(),
    supportUrl: z.string().url().max(255).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<VersionLocAttrs>(`/v1/appStoreVersions/${input.versionId}/appStoreVersionLocalizations`, {
      "fields[appStoreVersionLocalizations]": "locale",
      limit: 200,
    });
    const match = existing.find((l) => l.attributes?.locale === input.locale);
    const attributes: Record<string, unknown> = {};
    for (const k of ["description", "keywords", "promotionalText", "whatsNew", "marketingUrl", "supportUrl"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    if (match) {
      const res = await client.patch<{ data: { id: string; attributes: VersionLocAttrs } }>(`/v1/appStoreVersionLocalizations/${match.id}`, {
        data: { type: "appStoreVersionLocalizations", id: match.id, attributes },
      });
      return { id: match.id, action: "updated", attributes: res.data.attributes };
    }
    const res = await client.post<{ data: { id: string; attributes: VersionLocAttrs } }>("/v1/appStoreVersionLocalizations", {
      data: {
        type: "appStoreVersionLocalizations",
        attributes: { locale: input.locale, ...attributes },
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: input.versionId } } },
      },
    });
    return { id: res.data.id, action: "created", ...res.data.attributes };
  },
});

export const releaseToStoreTool = tool({
  name: "asc_release_to_store",
  description: "Manually release an approved version that's in PENDING_DEVELOPER_RELEASE. One-shot — no list/get on this resource.",
  inputSchema: z.object({ versionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.post("/v1/appStoreVersionReleaseRequests", {
      data: {
        type: "appStoreVersionReleaseRequests",
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: input.versionId } } },
      },
    });
  },
});

// AppInfo (non-version-specific marketing data: name, subtitle, categories, privacy URL).

export const getEditableAppInfoTool = tool({
  name: "asc_get_editable_app_info",
  description: "Find the currently-editable AppInfo for an app (state=PREPARE_FOR_SUBMISSION). The editable AppInfo is where you set categories, name, and subtitle for the next submission.",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const infos = await client.list<{ state?: string }>(`/v1/apps/${input.appId}/appInfos`, {
      include: "appInfoLocalizations,primaryCategory,primarySubcategoryOne,primarySubcategoryTwo,secondaryCategory,secondarySubcategoryOne,secondarySubcategoryTwo",
      limit: 50,
    });
    const editable = infos.find((i) => (i.attributes?.state ?? "").includes("PREPARE")) ?? infos[0];
    if (!editable) throw new Error(`No AppInfo found for app ${input.appId}.`);
    return { id: editable.id, ...editable.attributes, relationships: editable.relationships };
  },
});

export const setAppCategoriesTool = tool({
  name: "asc_set_app_categories",
  description: "Set primary and (optionally) secondary categories on the editable AppInfo. Use asc_list_categories to discover ids.",
  inputSchema: z.object({
    appInfoId: z.string(),
    primaryCategoryId: z.string(),
    secondaryCategoryId: z.string().optional(),
    primarySubcategoryOneId: z.string().optional(),
    primarySubcategoryTwoId: z.string().optional(),
    secondarySubcategoryOneId: z.string().optional(),
    secondarySubcategoryTwoId: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const rel: Record<string, unknown> = {
      primaryCategory: { data: { type: "appCategories", id: input.primaryCategoryId } },
    };
    if (input.secondaryCategoryId) rel.secondaryCategory = { data: { type: "appCategories", id: input.secondaryCategoryId } };
    if (input.primarySubcategoryOneId) rel.primarySubcategoryOne = { data: { type: "appCategories", id: input.primarySubcategoryOneId } };
    if (input.primarySubcategoryTwoId) rel.primarySubcategoryTwo = { data: { type: "appCategories", id: input.primarySubcategoryTwoId } };
    if (input.secondarySubcategoryOneId) rel.secondarySubcategoryOne = { data: { type: "appCategories", id: input.secondarySubcategoryOneId } };
    if (input.secondarySubcategoryTwoId) rel.secondarySubcategoryTwo = { data: { type: "appCategories", id: input.secondarySubcategoryTwoId } };
    return await client.patch(`/v1/appInfos/${input.appInfoId}`, {
      data: { type: "appInfos", id: input.appInfoId, relationships: rel },
    });
  },
});

export const setAppInfoLocalizationTool = tool({
  name: "asc_set_app_info_localization",
  description: "Upsert per-locale app-level info (name ≤30, subtitle ≤30, privacyPolicyUrl, privacyChoicesUrl). Locale name is REQUIRED on first create. AppInfo state must be editable.",
  inputSchema: z.object({
    appInfoId: z.string(),
    locale: z.string(),
    name: z.string().max(30).optional(),
    subtitle: z.string().max(30).optional(),
    privacyPolicyUrl: z.string().url().optional(),
    privacyChoicesUrl: z.string().url().optional(),
    privacyPolicyText: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<{ locale?: string }>(`/v1/appInfos/${input.appInfoId}/appInfoLocalizations`, { limit: 200 });
    const match = existing.find((l) => l.attributes?.locale === input.locale);
    const attributes: Record<string, unknown> = {};
    for (const k of ["name", "subtitle", "privacyPolicyUrl", "privacyChoicesUrl", "privacyPolicyText"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    if (match) {
      const res = await client.patch<{ data: { id: string; attributes?: Record<string, unknown> } }>(`/v1/appInfoLocalizations/${match.id}`, {
        data: { type: "appInfoLocalizations", id: match.id, attributes },
      });
      return { id: match.id, action: "updated", attributes: res.data.attributes };
    }
    if (!input.name) throw new Error("name is required when creating a new appInfoLocalization.");
    const res = await client.post<{ data: { id: string } }>("/v1/appInfoLocalizations", {
      data: {
        type: "appInfoLocalizations",
        attributes: { locale: input.locale, ...attributes },
        relationships: { appInfo: { data: { type: "appInfos", id: input.appInfoId } } },
      },
    });
    return { id: res.data.id, action: "created" };
  },
});

export const setReviewDetailsTool = tool({
  name: "asc_set_review_details",
  description: "Set the App Review contact info and demo credentials for a version. If your app has a login, demoAccountRequired must be true and creds must be set.",
  inputSchema: z.object({
    versionId: z.string(),
    contactFirstName: z.string().optional(),
    contactLastName: z.string().optional(),
    contactPhone: z.string().optional(),
    contactEmail: z.string().email().optional(),
    demoAccountName: z.string().optional(),
    demoAccountPassword: z.string().optional(),
    demoAccountRequired: z.boolean().optional(),
    notes: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    // Find the existing AppStoreReviewDetail for this version (created automatically with version in 4.x), then PATCH.
    // The relationship is at /v1/appStoreVersions/{id}/appStoreReviewDetail.
    const existing = await client.get<{ data?: { id: string } | null }>(`/v1/appStoreVersions/${input.versionId}/appStoreReviewDetail`).catch(() => ({ data: null }));
    const attributes: Record<string, unknown> = {};
    for (const k of ["contactFirstName","contactLastName","contactPhone","contactEmail","demoAccountName","demoAccountPassword","demoAccountRequired","notes"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    if (existing && existing.data) {
      const id = existing.data.id;
      return await client.patch(`/v1/appStoreReviewDetails/${id}`, {
        data: { type: "appStoreReviewDetails", id, attributes },
      });
    }
    return await client.post("/v1/appStoreReviewDetails", {
      data: {
        type: "appStoreReviewDetails",
        attributes,
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: input.versionId } } },
      },
    });
  },
});
