import { z } from "zod";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { tool } from "./registry.js";
import { runUpload } from "../upload.js";
import type { ScreenshotAttrs, UploadOperation } from "../types.js";

/**
 * In-App Events (appEvents): time-boxed, promotable events shown on the product page and in search/Today.
 * Lifecycle: create the event → localize it → upload the event card / details-page art → set the
 * per-territory schedule → submit for review via asc_submit_for_review (item type "appEvent").
 *
 * Shapes confirmed against the App Store Connect OpenAPI spec. Asset upload reuses the shared
 * reservation → multipart PUT → checksum-commit runner (runUpload), same as app/IAP screenshots.
 */

const EVENT_BADGES = ["LIVE_EVENT", "PREMIERE", "CHALLENGE", "COMPETITION", "NEW_SEASON", "MAJOR_UPDATE", "SPECIAL_EVENT"] as const;
const EVENT_PRIORITIES = ["HIGH", "NORMAL"] as const;
const EVENT_PURPOSES = ["APPROPRIATE_FOR_ALL_USERS", "ATTRACT_NEW_USERS", "KEEP_ACTIVE_USERS_INFORMED", "BRING_BACK_LAPSED_USERS"] as const;
const EVENT_ASSET_TYPES = ["EVENT_CARD", "EVENT_DETAILS_PAGE"] as const;

// Per-territory run window. publishStart = when the event card appears; eventStart/eventEnd bound the event.
const territorySchedule = z.object({
  territories: z.array(z.string()).min(1).describe("Territory codes this window applies to, e.g. [\"USA\",\"GBR\"]."),
  publishStart: z.string().describe("ISO-8601 date-time the event becomes visible."),
  eventStart: z.string().describe("ISO-8601 date-time the event starts."),
  eventEnd: z.string().describe("ISO-8601 date-time the event ends."),
});

export const listAppEventsTool = tool({
  name: "asc_list_app_events",
  description: "List the in-app events for an app (id, referenceName, badge, eventState, priority, purpose).",
  inputSchema: z.object({
    appId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const events = await client.list(`/v1/apps/${input.appId}/appEvents`, {
      limit: input.limit ?? 100,
      "fields[appEvents]": "referenceName,badge,eventState,priority,purpose,deepLink,primaryLocale",
    });
    return events.map((e) => ({ id: e.id, ...e.attributes }));
  },
});

export const createAppEventTool = tool({
  name: "asc_create_app_event",
  description:
    "Create an in-app event. referenceName is the internal name. Set the customer-facing text per locale with " +
    "asc_set_app_event_localization, the card/details art with asc_upload_app_event_screenshot, and the run window " +
    "with asc_update_app_event (territorySchedules) — then submit via asc_submit_for_review with {type:\"appEvent\", id}.",
  inputSchema: z.object({
    appId: z.string(),
    referenceName: z.string().describe("Internal reference name (not customer-facing)."),
    badge: z.enum(EVENT_BADGES).optional().describe("The badge shown on the event card."),
    priority: z.enum(EVENT_PRIORITIES).optional(),
    purpose: z.enum(EVENT_PURPOSES).optional(),
    primaryLocale: z.string().optional().describe("e.g. en-US."),
    deepLink: z.string().optional().describe("Universal link that opens the event in the app."),
    purchaseRequirement: z.string().optional(),
    territorySchedules: z.array(territorySchedule).optional().describe("Per-territory run windows (can also be set later via asc_update_app_event)."),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = { referenceName: input.referenceName };
    for (const k of ["badge", "priority", "purpose", "primaryLocale", "deepLink", "purchaseRequirement", "territorySchedules"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/appEvents", {
      data: { type: "appEvents", attributes, relationships: { app: { data: { type: "apps", id: input.appId } } } },
    });
    return { ok: true, appEventId: res.data.id, ...res.data.attributes };
  },
});

export const updateAppEventTool = tool({
  name: "asc_update_app_event",
  description:
    "Update an in-app event — most often to set territorySchedules (the per-territory publish/start/end windows Apple " +
    "requires before the event can be submitted). Only the fields you pass change.",
  inputSchema: z.object({
    appEventId: z.string(),
    badge: z.enum(EVENT_BADGES).optional(),
    priority: z.enum(EVENT_PRIORITIES).optional(),
    purpose: z.enum(EVENT_PURPOSES).optional(),
    deepLink: z.string().optional(),
    purchaseRequirement: z.string().optional(),
    territorySchedules: z.array(territorySchedule).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {};
    for (const k of ["badge", "priority", "purpose", "deepLink", "purchaseRequirement", "territorySchedules"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    if (Object.keys(attributes).length === 0) throw new Error("Pass at least one field to update.");
    const res = await client.patch<{ data: { id: string; attributes?: Record<string, unknown> } }>(`/v1/appEvents/${input.appEventId}`, {
      data: { type: "appEvents", id: input.appEventId, attributes },
    });
    return { ok: true, appEventId: input.appEventId, ...res.data.attributes };
  },
});

export const setAppEventLocalizationTool = tool({
  name: "asc_set_app_event_localization",
  description:
    "Upsert the customer-facing text of an in-app event for one locale: name, shortDescription, longDescription. " +
    "Creates the localization if missing, otherwise PATCHes it. name is required on first create for a locale.",
  inputSchema: z.object({
    appEventId: z.string(),
    locale: z.string().describe("e.g. en-US, ja, de-DE."),
    name: z.string().optional().describe("Event name (required on first create for a locale)."),
    shortDescription: z.string().optional(),
    longDescription: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<{ locale?: string }>(`/v1/appEvents/${input.appEventId}/localizations`, {
      limit: 200,
      "fields[appEventLocalizations]": "locale",
    });
    const match = existing.find((l) => l.attributes?.locale === input.locale);
    const attributes: Record<string, unknown> = {};
    for (const k of ["name", "shortDescription", "longDescription"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    if (match) {
      const res = await client.patch<{ data: { id: string; attributes?: Record<string, unknown> } }>(
        `/v1/appEventLocalizations/${match.id}`,
        { data: { type: "appEventLocalizations", id: match.id, attributes } },
      );
      return { id: match.id, action: "updated", ...res.data.attributes };
    }
    if (!input.name) throw new Error("name is required when creating a new appEventLocalization.");
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/appEventLocalizations", {
      data: {
        type: "appEventLocalizations",
        attributes: { locale: input.locale, ...attributes },
        relationships: { appEvent: { data: { type: "appEvents", id: input.appEventId } } },
      },
    });
    return { id: res.data.id, action: "created", ...res.data.attributes };
  },
});

export const uploadAppEventScreenshotTool = tool({
  name: "asc_upload_app_event_screenshot",
  description:
    "Upload an in-app event image to a localization. assetType is EVENT_CARD (the card in search/Today) or " +
    "EVENT_DETAILS_PAGE (the hero on the event page). Reservation → multipart PUT → checksum commit. PNG/JPG. " +
    "Get the localizationId from asc_set_app_event_localization.",
  inputSchema: z.object({
    appEventLocalizationId: z.string(),
    filePath: z.string().describe("Absolute path to a .png or .jpg file."),
    assetType: z.enum(EVENT_ASSET_TYPES),
  }).strict(),
  handler: async (input, { client }) => {
    const st = await stat(input.filePath);
    const fileName = basename(input.filePath);
    const reservation = await client.post<{ data: { id: string; attributes: ScreenshotAttrs } }>("/v1/appEventScreenshots", {
      data: {
        type: "appEventScreenshots",
        attributes: { fileName, fileSize: st.size, appEventAssetType: input.assetType },
        relationships: { appEventLocalization: { data: { type: "appEventLocalizations", id: input.appEventLocalizationId } } },
      },
    });
    const screenshotId = reservation.data.id;
    const checksum = await runUpload(input.filePath, reservation.data.attributes?.uploadOperations ?? []);
    const committed = await client.patch<{ data: { id: string; attributes: ScreenshotAttrs } }>(
      `/v1/appEventScreenshots/${screenshotId}`,
      { data: { type: "appEventScreenshots", id: screenshotId, attributes: { uploaded: true, sourceFileChecksum: checksum } } },
    );
    return { id: screenshotId, fileName, assetType: input.assetType, assetDeliveryState: committed.data.attributes?.assetDeliveryState };
  },
});

export const uploadAppEventVideoClipTool = tool({
  name: "asc_upload_app_event_video_clip",
  description:
    "Upload an in-app event video clip to a localization (assetType EVENT_CARD or EVENT_DETAILS_PAGE). Same " +
    "reservation → PUT → commit flow as screenshots; optionally set the poster frame timecode (e.g. \"00:00:02:00\").",
  inputSchema: z.object({
    appEventLocalizationId: z.string(),
    filePath: z.string().describe("Absolute path to an .mp4/.mov/.m4v file."),
    assetType: z.enum(EVENT_ASSET_TYPES),
    previewFrameTimeCode: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const st = await stat(input.filePath);
    const fileName = basename(input.filePath);
    const reservation = await client.post<{ data: { id: string; attributes: { uploadOperations?: UploadOperation[] } } }>(
      "/v1/appEventVideoClips",
      {
        data: {
          type: "appEventVideoClips",
          attributes: { fileName, fileSize: st.size, appEventAssetType: input.assetType },
          relationships: { appEventLocalization: { data: { type: "appEventLocalizations", id: input.appEventLocalizationId } } },
        },
      },
    );
    const clipId = reservation.data.id;
    const checksum = await runUpload(input.filePath, reservation.data.attributes?.uploadOperations ?? []);
    const attributes: Record<string, unknown> = { uploaded: true, sourceFileChecksum: checksum };
    if (input.previewFrameTimeCode) attributes.previewFrameTimeCode = input.previewFrameTimeCode;
    const committed = await client.patch<{ data: { id: string; attributes?: Record<string, unknown> } }>(
      `/v1/appEventVideoClips/${clipId}`,
      { data: { type: "appEventVideoClips", id: clipId, attributes } },
    );
    return { id: clipId, fileName, assetType: input.assetType, ...committed.data.attributes };
  },
});

export const deleteAppEventTool = tool({
  name: "asc_delete_app_event",
  description: "Delete an in-app event by id (DELETE /v1/appEvents/{id}). Find ids via asc_list_app_events.",
  inputSchema: z.object({ appEventId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/appEvents/${input.appEventId}`);
    return { ok: true, deleted: input.appEventId };
  },
});
