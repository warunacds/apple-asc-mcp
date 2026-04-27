import { z } from "zod";
import { tool } from "./registry.js";
import type { AppAttrs, AppStoreVersionAttrs, BuildAttrs, VersionLocAttrs } from "../types.js";

export const whoamiTool = tool({
  name: "asc_whoami",
  description: "Verify App Store Connect API credentials work and return the count of apps visible to this key. Use this first when troubleshooting auth.",
  inputSchema: z.object({}).strict(),
  handler: async (_input, { client, config }) => {
    const apps = await client.list<AppAttrs>("/v1/apps", { limit: 1 });
    return {
      ok: true,
      keyId: config.keyId,
      issuerId: config.issuerId,
      privateKeyPath: config.privateKeyPath ?? "(supplied inline)",
      sampleAppId: apps[0]?.id,
      sampleAppName: apps[0]?.attributes?.name,
      message: `Successfully authenticated. Found ${apps.length ? "at least one" : "zero"} app(s).`,
    };
  },
});

export const listAppsTool = tool({
  name: "asc_list_apps",
  description: "List apps visible to this API key. Optional filters by bundleId or name (exact match). Returns id, name, bundleId, sku, primaryLocale.",
  inputSchema: z.object({
    bundleId: z.string().optional().describe("Filter by exact bundle identifier (e.g. com.example.app). Comma-separated list also accepted."),
    name: z.string().optional().describe("Filter by exact app name (not a substring match)."),
    limit: z.number().int().min(1).max(200).default(50).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const query: Record<string, string | number | string[] | undefined> = {
      limit: input.limit ?? 50,
      "fields[apps]": "name,bundleId,sku,primaryLocale,contentRightsDeclaration",
    };
    if (input.bundleId) query["filter[bundleId]"] = input.bundleId;
    if (input.name) query["filter[name]"] = input.name;
    const apps = await client.list<AppAttrs>("/v1/apps", query);
    return apps.map((a) => ({ id: a.id, ...a.attributes }));
  },
});

export const getAppTool = tool({
  name: "asc_get_app",
  description: "Get a single app by App Store ID OR by bundleId. Returns the app and lightly sideloaded current versions/builds.",
  inputSchema: z.object({
    appId: z.string().optional().describe("App Store ID (numeric resource id)."),
    bundleId: z.string().optional().describe("Bundle identifier; resolved to an app id."),
  }).strict().refine((v) => v.appId || v.bundleId, { message: "Provide appId or bundleId." }),
  handler: async (input, { client }) => {
    let id = input.appId;
    if (!id) {
      const apps = await client.list<AppAttrs>("/v1/apps", { "filter[bundleId]": input.bundleId!, limit: 1 });
      if (!apps.length) throw new Error(`No app found for bundleId=${input.bundleId}`);
      id = apps[0]!.id;
    }
    const single = await client.get<{ data: { id: string; attributes: AppAttrs }; included?: unknown[] }>(`/v1/apps/${id}`, {
      query: {
        "fields[apps]": "name,bundleId,sku,primaryLocale,contentRightsDeclaration,appStoreVersions,builds,appInfos,reviewSubmissions",
        include: "appStoreVersions,builds,appInfos",
        "limit[appStoreVersions]": 5,
        "limit[builds]": 5,
        "fields[appStoreVersions]": "versionString,platform,appStoreState,appVersionState,createdDate",
        "fields[builds]": "version,uploadedDate,processingState,expired",
        "fields[appInfos]": "state",
      },
    });
    return single;
  },
});

export const listBuildsTool = tool({
  name: "asc_list_builds",
  description: "List builds for an app, optionally filtered by processing state, version (CFBundleVersion), or expired flag. Sorted newest-uploaded-first by default.",
  inputSchema: z.object({
    appId: z.string(),
    processingState: z.enum(["PROCESSING", "FAILED", "INVALID", "VALID"]).optional(),
    version: z.string().optional().describe("CFBundleVersion (build number, e.g. \"42\")."),
    preReleaseVersion: z.string().optional().describe("Marketing version (e.g. \"1.4.0\")."),
    expired: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).default(20).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const q: Record<string, string | number | boolean | undefined> = {
      "filter[app]": input.appId,
      sort: "-uploadedDate",
      limit: input.limit ?? 20,
      "fields[builds]": "version,uploadedDate,expirationDate,expired,processingState,buildAudienceType,minOsVersion,usesNonExemptEncryption",
    };
    if (input.processingState) q["filter[processingState]"] = input.processingState;
    if (input.version) q["filter[version]"] = input.version;
    if (input.preReleaseVersion) q["filter[preReleaseVersion.version]"] = input.preReleaseVersion;
    if (input.expired !== undefined) q["filter[expired]"] = input.expired;
    const builds = await client.list<BuildAttrs>("/v1/builds", q);
    return builds.map((b) => ({ id: b.id, ...b.attributes }));
  },
});

export const getBuildTool = tool({
  name: "asc_get_build",
  description: "Get a single build by id, including its preReleaseVersion and any attached app store version.",
  inputSchema: z.object({ buildId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.get(`/v1/builds/${input.buildId}`, {
      query: {
        "fields[builds]": "version,uploadedDate,expirationDate,expired,processingState,buildAudienceType,minOsVersion,usesNonExemptEncryption",
        include: "preReleaseVersion,appStoreVersion,buildBetaDetail",
      },
    });
  },
});

export const listVersionsTool = tool({
  name: "asc_list_versions",
  description: "List App Store Versions for an app, optionally filtered by platform or state. Use this to find the editable version (state=PREPARE_FOR_SUBMISSION).",
  inputSchema: z.object({
    appId: z.string(),
    platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).optional(),
    appVersionState: z.string().optional().describe("e.g. PREPARE_FOR_SUBMISSION, READY_FOR_REVIEW, IN_REVIEW, ACCEPTED, READY_FOR_DISTRIBUTION."),
    limit: z.number().int().min(1).max(200).default(20).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const q: Record<string, string | number | undefined> = {
      limit: input.limit ?? 20,
      "fields[appStoreVersions]": "versionString,platform,appStoreState,appVersionState,createdDate,releaseType,earliestReleaseDate,copyright",
    };
    if (input.platform) q["filter[platform]"] = input.platform;
    if (input.appVersionState) q["filter[appVersionState]"] = input.appVersionState;
    const versions = await client.list<AppStoreVersionAttrs>(`/v1/apps/${input.appId}/appStoreVersions`, q);
    return versions.map((v) => ({ id: v.id, ...v.attributes }));
  },
});

export const getVersionTool = tool({
  name: "asc_get_version",
  description: "Read a single App Store Version with its build, localizations, review detail, and phased release sideloaded.",
  inputSchema: z.object({ versionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.get(`/v1/appStoreVersions/${input.versionId}`, {
      query: {
        include: "build,appStoreVersionLocalizations,appStoreReviewDetail,appStoreVersionPhasedRelease",
        "fields[appStoreVersions]": "versionString,platform,appStoreState,appVersionState,createdDate,releaseType,earliestReleaseDate,copyright,reviewType,downloadable",
        "fields[appStoreVersionLocalizations]": "locale,description,keywords,promotionalText,whatsNew,marketingUrl,supportUrl",
        "fields[builds]": "version,uploadedDate,processingState",
      },
    });
  },
});

export const listLocalizationsTool = tool({
  name: "asc_list_version_localizations",
  description: "List the per-locale marketing copy under an App Store Version (description, keywords, whatsNew, etc.).",
  inputSchema: z.object({ versionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const locs = await client.list<VersionLocAttrs>(`/v1/appStoreVersions/${input.versionId}/appStoreVersionLocalizations`, {
      limit: 200,
      "fields[appStoreVersionLocalizations]": "locale,description,keywords,promotionalText,whatsNew,marketingUrl,supportUrl",
    });
    return locs.map((l) => ({ id: l.id, ...l.attributes }));
  },
});

export const listCategoriesTool = tool({
  name: "asc_list_categories",
  description: "List App Store categories for a platform. Use the returned ids when setting primary/secondary categories on an AppInfo.",
  inputSchema: z.object({
    platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
  }).strict(),
  handler: async (input, { client }) => {
    const cats = await client.list<{ platforms?: string[] }>("/v1/appCategories", {
      "filter[platforms]": input.platform,
      include: "subcategories",
      limit: 200,
    });
    return cats.map((c) => ({ id: c.id, name: c.id, platforms: c.attributes?.platforms }));
  },
});
