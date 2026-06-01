import { z } from "zod";
import { tool } from "./registry.js";
import type { AppAttrs, AppStoreVersionAttrs, BuildAttrs, InAppPurchaseAttrs, ScreenshotAttrs, VersionLocAttrs } from "../types.js";

/**
 * Single tool that returns "the state of the world" for an app — the editable version, the
 * latest valid build, every localization with its screenshot coverage, and a checklist of
 * what's still blocking submission. Designed so Claude can call this once and decide what to
 * do next without orchestrating a dozen reads.
 */
export const releaseStatusTool = tool({
  name: "asc_release_status",
  description:
    "One-shot snapshot of an app's current release readiness: which version is editable, what build is attached, which locales are present, screenshot/preview coverage per device class, review details, and a blocking-issue checklist. " +
    "Call this whenever you need to plan the next step.",
  inputSchema: z.object({
    appId: z.string().optional(),
    bundleId: z.string().optional(),
    platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
  }).strict().refine((v) => v.appId || v.bundleId, { message: "Provide appId or bundleId." }),
  handler: async (input, { client }) => {
    let appId = input.appId;
    let appName: string | undefined;
    let bundleId: string | undefined;
    let primaryLocale: string | undefined;
    if (!appId) {
      const apps = await client.list<AppAttrs>("/v1/apps", { "filter[bundleId]": input.bundleId!, limit: 1 });
      if (!apps.length) throw new Error(`No app found for bundleId=${input.bundleId}`);
      appId = apps[0]!.id;
      appName = apps[0]!.attributes?.name;
      bundleId = apps[0]!.attributes?.bundleId;
      primaryLocale = apps[0]!.attributes?.primaryLocale;
    } else {
      const app = await client.getOne<AppAttrs>(`/v1/apps/${appId}`);
      appName = app.attributes?.name;
      bundleId = app.attributes?.bundleId;
      primaryLocale = app.attributes?.primaryLocale;
    }

    // Editable version (PREPARE_FOR_SUBMISSION) for the platform, or the latest version overall.
    const versions = await client.list<AppStoreVersionAttrs>(`/v1/apps/${appId}/appStoreVersions`, {
      "filter[platform]": input.platform,
      limit: 10,
      "fields[appStoreVersions]": "versionString,platform,appStoreState,appVersionState,createdDate,releaseType,earliestReleaseDate,copyright",
    });
    const editable = versions.find((v) => (v.attributes?.appVersionState ?? v.attributes?.appStoreState ?? "").includes("PREPARE")) ?? versions[0];

    // Builds (most recent VALID).
    const builds = await client.list<BuildAttrs>("/v1/builds", {
      "filter[app]": appId,
      "filter[processingState]": "VALID",
      sort: "-uploadedDate",
      limit: 5,
      "fields[builds]": "version,uploadedDate,expirationDate,expired,processingState,buildAudienceType,minOsVersion,usesNonExemptEncryption",
    });
    const allBuilds = await client.list<BuildAttrs>("/v1/builds", {
      "filter[app]": appId,
      sort: "-uploadedDate",
      limit: 5,
      "fields[builds]": "version,uploadedDate,processingState",
    });

    // Localizations and screenshot sets for the editable version.
    const localizations: Array<{
      id: string;
      locale?: string;
      hasDescription: boolean;
      hasKeywords: boolean;
      hasWhatsNew: boolean;
      screenshotSets: Array<{ id: string; displayType?: string; count: number; assetStates: Record<string, number> }>;
      previewSets: Array<{ id: string; previewType?: string; count: number }>;
    }> = [];

    if (editable) {
      const locs = await client.list<VersionLocAttrs>(`/v1/appStoreVersions/${editable.id}/appStoreVersionLocalizations`, {
        limit: 200,
        "fields[appStoreVersionLocalizations]": "locale,description,keywords,whatsNew,promotionalText,marketingUrl,supportUrl",
      });
      for (const loc of locs) {
        const sets = await client.list<{ screenshotDisplayType?: string }>(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`, {
          limit: 50,
          "fields[appScreenshotSets]": "screenshotDisplayType",
        });
        const screenshotSets = await Promise.all(sets.map(async (s) => {
          const shots = await client.list<ScreenshotAttrs>(`/v1/appScreenshotSets/${s.id}/appScreenshots`, {
            limit: 20,
            "fields[appScreenshots]": "fileName,assetDeliveryState",
          });
          const assetStates: Record<string, number> = {};
          for (const shot of shots) {
            const st = shot.attributes?.assetDeliveryState?.state ?? "UNKNOWN";
            assetStates[st] = (assetStates[st] ?? 0) + 1;
          }
          return { id: s.id, displayType: s.attributes?.screenshotDisplayType, count: shots.length, assetStates };
        }));
        const pSets = await client.list<{ previewType?: string }>(`/v1/appStoreVersionLocalizations/${loc.id}/appPreviewSets`, {
          limit: 50,
          "fields[appPreviewSets]": "previewType",
        });
        const previewSets = await Promise.all(pSets.map(async (p) => {
          const prev = await client.list(`/v1/appPreviewSets/${p.id}/appPreviews`, { limit: 5 });
          return { id: p.id, previewType: p.attributes?.previewType, count: prev.length };
        }));
        localizations.push({
          id: loc.id,
          locale: loc.attributes?.locale,
          hasDescription: !!loc.attributes?.description,
          hasKeywords: !!loc.attributes?.keywords,
          hasWhatsNew: !!loc.attributes?.whatsNew,
          screenshotSets,
          previewSets,
        });
      }
    }

    // Review detail
    let reviewDetail: { id?: string; demoAccountRequired?: boolean; hasContact?: boolean } | undefined;
    if (editable) {
      try {
        const detail = await client.get<{ data?: { id: string; attributes?: Record<string, unknown> } | null }>(`/v1/appStoreVersions/${editable.id}/appStoreReviewDetail`);
        const a = detail?.data?.attributes as Record<string, unknown> | undefined;
        reviewDetail = detail?.data ? {
          id: detail.data.id,
          demoAccountRequired: a?.demoAccountRequired as boolean | undefined,
          hasContact: !!(a?.contactEmail || a?.contactPhone),
        } : undefined;
      } catch {
        reviewDetail = undefined;
      }
    }

    // Latest review submission for this app
    const submissions = await client.list<{ state?: string; submittedDate?: string; platform?: string }>("/v1/reviewSubmissions", {
      "filter[app]": appId,
      sort: "-createdDate",
      limit: 3,
      "fields[reviewSubmissions]": "platform,submittedDate,state",
    }).catch(() => []);

    // In-app purchases — informational readiness signal (an unfinished IAP doesn't block the app
    // version itself, but the agent should see which ones still need work). Best-effort.
    const iaps = await client.list<InAppPurchaseAttrs>(`/v1/apps/${appId}/inAppPurchasesV2`, {
      limit: 200,
      "fields[inAppPurchases]": "name,productId,inAppPurchaseType,state",
    }).catch(() => []);
    const iapByState: Record<string, number> = {};
    for (const i of iaps) {
      const s = i.attributes?.state ?? "UNKNOWN";
      iapByState[s] = (iapByState[s] ?? 0) + 1;
    }
    const iapNeedingAction = iaps
      .filter((i) => ["MISSING_METADATA", "DEVELOPER_ACTION_NEEDED"].includes(i.attributes?.state ?? ""))
      .map((i) => ({ id: i.id, productId: i.attributes?.productId, state: i.attributes?.state }));

    // Blocker checklist
    const blockers: string[] = [];
    if (!editable) blockers.push(`No editable App Store Version for platform=${input.platform}. Use asc_create_version.`);
    if (editable && !builds.length) blockers.push("No VALID build available to attach. Upload one with asc_upload_ipa, then wait with asc_wait_for_build_processing.");
    if (editable && !localizations.length) blockers.push("Version has no localizations yet. At minimum, set the primary locale via asc_set_version_localization.");
    if (editable) {
      const primaryLoc = localizations.find((l) => l.locale === primaryLocale);
      if (primaryLoc) {
        if (!primaryLoc.hasDescription) blockers.push(`Primary locale ${primaryLocale} has no description.`);
        if (!primaryLoc.hasKeywords) blockers.push(`Primary locale ${primaryLocale} has no keywords.`);
        if (input.platform === "IOS") {
          const hasIPhoneScreenshots = primaryLoc.screenshotSets.some((s) => s.displayType?.startsWith("APP_IPHONE_") && s.count > 0);
          if (!hasIPhoneScreenshots) blockers.push(`Primary locale ${primaryLocale} has no iPhone screenshots. Upload at least one set (e.g. APP_IPHONE_67).`);
        }
      }
    }
    if (reviewDetail?.demoAccountRequired && !reviewDetail.hasContact) {
      blockers.push("Review demo account is required but contact info isn't set. Use asc_set_review_details.");
    }

    return {
      app: { id: appId, name: appName, bundleId, primaryLocale },
      platform: input.platform,
      editableVersion: editable ? { id: editable.id, ...editable.attributes } : null,
      latestValidBuild: builds[0] ? { id: builds[0].id, ...builds[0].attributes } : null,
      recentBuilds: allBuilds.map((b) => ({ id: b.id, ...b.attributes })),
      localizations,
      reviewDetail,
      recentReviewSubmissions: submissions.map((s) => ({ id: s.id, ...s.attributes })),
      inAppPurchases: { count: iaps.length, byState: iapByState, needingAction: iapNeedingAction },
      blockers,
      readyToSubmit: blockers.length === 0,
    };
  },
});
