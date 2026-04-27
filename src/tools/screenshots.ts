import { z } from "zod";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { tool } from "./registry.js";
import { runUpload } from "../upload.js";
import type { ScreenshotAttrs } from "../types.js";

const SCREENSHOT_DISPLAY_TYPES = [
  "APP_IPHONE_67","APP_IPHONE_65","APP_IPHONE_61","APP_IPHONE_58","APP_IPHONE_55","APP_IPHONE_47","APP_IPHONE_40","APP_IPHONE_35",
  "APP_IPAD_PRO_3GEN_129","APP_IPAD_PRO_3GEN_11","APP_IPAD_PRO_129","APP_IPAD_105","APP_IPAD_97",
  "APP_DESKTOP","APP_WATCH_ULTRA","APP_WATCH_SERIES_10","APP_WATCH_SERIES_7","APP_WATCH_SERIES_4","APP_WATCH_SERIES_3",
  "APP_APPLE_TV","APP_APPLE_VISION_PRO",
  "IMESSAGE_APP_IPHONE_67","IMESSAGE_APP_IPHONE_65","IMESSAGE_APP_IPHONE_61","IMESSAGE_APP_IPHONE_58","IMESSAGE_APP_IPHONE_55","IMESSAGE_APP_IPHONE_47","IMESSAGE_APP_IPHONE_40",
  "IMESSAGE_APP_IPAD_PRO_3GEN_129","IMESSAGE_APP_IPAD_PRO_3GEN_11","IMESSAGE_APP_IPAD_PRO_129","IMESSAGE_APP_IPAD_105","IMESSAGE_APP_IPAD_97",
] as const;

const PREVIEW_TYPES = [
  "IPHONE_67","IPHONE_65","IPHONE_61","IPHONE_58","IPHONE_55","IPHONE_47","IPHONE_40","IPHONE_35",
  "IPAD_PRO_3GEN_129","IPAD_PRO_3GEN_11","IPAD_PRO_129","IPAD_105","IPAD_97",
  "DESKTOP","APPLE_TV","APPLE_VISION_PRO",
] as const;

export const listScreenshotSetsTool = tool({
  name: "asc_list_screenshot_sets",
  description: "List screenshot sets under an App Store Version Localization. One set per (locale, displayType).",
  inputSchema: z.object({ localizationId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const sets = await client.list(`/v1/appStoreVersionLocalizations/${input.localizationId}/appScreenshotSets`, { limit: 50 });
    return sets.map((s) => ({ id: s.id, ...s.attributes }));
  },
});

export const findOrCreateScreenshotSetTool = tool({
  name: "asc_find_or_create_screenshot_set",
  description: "Idempotently get the screenshot set for a (localization, displayType) pair, creating it if missing. Returns the set id.",
  inputSchema: z.object({
    localizationId: z.string(),
    displayType: z.enum(SCREENSHOT_DISPLAY_TYPES),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<{ screenshotDisplayType?: string }>(
      `/v1/appStoreVersionLocalizations/${input.localizationId}/appScreenshotSets`,
      { limit: 50 },
    );
    const match = existing.find((s) => s.attributes?.screenshotDisplayType === input.displayType);
    if (match) return { id: match.id, displayType: input.displayType, action: "found" };
    const created = await client.post<{ data: { id: string } }>("/v1/appScreenshotSets", {
      data: {
        type: "appScreenshotSets",
        attributes: { screenshotDisplayType: input.displayType },
        relationships: {
          appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: input.localizationId } },
        },
      },
    });
    return { id: created.data.id, displayType: input.displayType, action: "created" };
  },
});

export const uploadScreenshotTool = tool({
  name: "asc_upload_screenshot",
  description:
    "Upload a single screenshot file to a screenshot set. Performs the full reservation → multipart PUT → checksum-commit dance. Use asc_find_or_create_screenshot_set first to get setId. " +
    "Constraints: PNG/JPG, no transparency, all screenshots in a set must share dimensions, 1-10 per set per locale.",
  inputSchema: z.object({
    setId: z.string(),
    filePath: z.string().describe("Absolute path to a .png or .jpg file."),
  }).strict(),
  handler: async (input, { client }) => {
    const st = await stat(input.filePath);
    const fileName = basename(input.filePath);
    const reservation = await client.post<{ data: { id: string; attributes: ScreenshotAttrs } }>("/v1/appScreenshots", {
      data: {
        type: "appScreenshots",
        attributes: { fileName, fileSize: st.size },
        relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: input.setId } } },
      },
    });
    const screenshotId = reservation.data.id;
    const ops = reservation.data.attributes?.uploadOperations ?? [];
    const checksum = await runUpload(input.filePath, ops);
    const committed = await client.patch<{ data: { id: string; attributes: ScreenshotAttrs } }>(`/v1/appScreenshots/${screenshotId}`, {
      data: { type: "appScreenshots", id: screenshotId, attributes: { uploaded: true, sourceFileChecksum: checksum } },
    });
    return {
      id: screenshotId,
      fileName,
      fileSize: st.size,
      assetDeliveryState: committed.data.attributes?.assetDeliveryState,
      imageAsset: committed.data.attributes?.imageAsset,
    };
  },
});

export const deleteScreenshotTool = tool({
  name: "asc_delete_screenshot",
  description: "Delete a single screenshot.",
  inputSchema: z.object({ screenshotId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/appScreenshots/${input.screenshotId}`);
    return { ok: true, screenshotId: input.screenshotId };
  },
});

export const reorderScreenshotsTool = tool({
  name: "asc_reorder_screenshots",
  description: "Set the display order of screenshots within a set. Provide screenshotIds in the desired order.",
  inputSchema: z.object({
    setId: z.string(),
    screenshotIds: z.array(z.string()).min(1).max(10),
  }).strict(),
  handler: async (input, { client }) => {
    await client.patch(`/v1/appScreenshotSets/${input.setId}/relationships/appScreenshots`, {
      data: input.screenshotIds.map((id) => ({ type: "appScreenshots", id })),
    });
    return { ok: true, setId: input.setId, order: input.screenshotIds };
  },
});

// App Previews (videos) — same pattern with a different resource type.

export const findOrCreatePreviewSetTool = tool({
  name: "asc_find_or_create_preview_set",
  description: "Idempotently get the App Preview set for a (localization, previewType) pair.",
  inputSchema: z.object({
    localizationId: z.string(),
    previewType: z.enum(PREVIEW_TYPES),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<{ previewType?: string }>(
      `/v1/appStoreVersionLocalizations/${input.localizationId}/appPreviewSets`,
      { limit: 50 },
    );
    const match = existing.find((s) => s.attributes?.previewType === input.previewType);
    if (match) return { id: match.id, previewType: input.previewType, action: "found" };
    const created = await client.post<{ data: { id: string } }>("/v1/appPreviewSets", {
      data: {
        type: "appPreviewSets",
        attributes: { previewType: input.previewType },
        relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: input.localizationId } } },
      },
    });
    return { id: created.data.id, previewType: input.previewType, action: "created" };
  },
});

export const uploadPreviewTool = tool({
  name: "asc_upload_preview",
  description: "Upload a video file (M4V/MP4/MOV, 15-30s, ≥30fps) to a preview set. Optionally set the poster frame timecode (e.g. \"00:00:05:01\").",
  inputSchema: z.object({
    setId: z.string(),
    filePath: z.string(),
    previewFrameTimeCode: z.string().optional(),
    mimeType: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const st = await stat(input.filePath);
    const fileName = basename(input.filePath);
    const ext = extname(input.filePath).toLowerCase();
    const mimeType = input.mimeType ?? (ext === ".m4v" ? "video/x-m4v" : ext === ".mov" ? "video/quicktime" : "video/mp4");
    const reservation = await client.post<{ data: { id: string; attributes: { uploadOperations?: import("../types.js").UploadOperation[] } } }>("/v1/appPreviews", {
      data: {
        type: "appPreviews",
        attributes: { fileName, fileSize: st.size, mimeType },
        relationships: { appPreviewSet: { data: { type: "appPreviewSets", id: input.setId } } },
      },
    });
    const previewId = reservation.data.id;
    const ops = reservation.data.attributes?.uploadOperations ?? [];
    const checksum = await runUpload(input.filePath, ops);
    const attributes: Record<string, unknown> = { uploaded: true, sourceFileChecksum: checksum };
    if (input.previewFrameTimeCode) attributes.previewFrameTimeCode = input.previewFrameTimeCode;
    return await client.patch(`/v1/appPreviews/${previewId}`, {
      data: { type: "appPreviews", id: previewId, attributes },
    });
  },
});
