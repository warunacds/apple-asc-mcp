import type { Tool } from "./registry.js";
import {
  whoamiTool, listAppsTool, getAppTool, listBuildsTool, getBuildTool,
  listVersionsTool, getVersionTool, listLocalizationsTool, listCategoriesTool,
  listTerritoriesTool,
} from "./discovery.js";
import {
  listInAppPurchasesTool, getInAppPurchaseTool, createInAppPurchaseTool, setIapLocalizationTool,
  listIapPricePointsTool, setIapPriceTool, setIapAvailabilityTool, uploadIapReviewScreenshotTool,
  submitIapForReviewTool,
} from "./iap.js";
import {
  createVersionTool, updateVersionTool, attachBuildTool, setVersionLocalizationTool,
  releaseToStoreTool, getEditableAppInfoTool, setAppCategoriesTool, setAppInfoLocalizationTool,
  setReviewDetailsTool,
} from "./metadata.js";
import {
  listScreenshotSetsTool, findOrCreateScreenshotSetTool, uploadScreenshotTool,
  deleteScreenshotTool, reorderScreenshotsTool, findOrCreatePreviewSetTool, uploadPreviewTool,
} from "./screenshots.js";
import { uploadIpaTool, validateIpaTool, waitForBuildTool } from "./upload.js";
import { xcArchiveTool, xcExportTool } from "./xcode_tools.js";
import { submitForReviewTool, getReviewSubmissionTool, listReviewSubmissionsTool, cancelReviewSubmissionTool } from "./reviews.js";
import { listBetaGroupsTool, setBetaWhatsNewTool, distributeToBetaGroupsTool, submitForBetaReviewTool } from "./testflight.js";
import { releaseStatusTool } from "./status.js";

export const ALL_TOOLS: Tool[] = [
  // Discovery (read-only)
  whoamiTool, listAppsTool, getAppTool, listBuildsTool, getBuildTool,
  listVersionsTool, getVersionTool, listLocalizationsTool, listCategoriesTool,
  listTerritoriesTool, releaseStatusTool,

  // Build & upload
  xcArchiveTool, xcExportTool, validateIpaTool, uploadIpaTool, waitForBuildTool,

  // Version & metadata
  createVersionTool, updateVersionTool, attachBuildTool, setVersionLocalizationTool,
  releaseToStoreTool, getEditableAppInfoTool, setAppCategoriesTool, setAppInfoLocalizationTool,
  setReviewDetailsTool,

  // Screenshots & previews
  listScreenshotSetsTool, findOrCreateScreenshotSetTool, uploadScreenshotTool,
  deleteScreenshotTool, reorderScreenshotsTool, findOrCreatePreviewSetTool, uploadPreviewTool,

  // Review submission (the modern reviewSubmissions API)
  submitForReviewTool, getReviewSubmissionTool, listReviewSubmissionsTool, cancelReviewSubmissionTool,

  // TestFlight
  listBetaGroupsTool, setBetaWhatsNewTool, distributeToBetaGroupsTool, submitForBetaReviewTool,

  // In-App Purchases (v2)
  listInAppPurchasesTool, getInAppPurchaseTool, createInAppPurchaseTool, setIapLocalizationTool,
  listIapPricePointsTool, setIapPriceTool, setIapAvailabilityTool, uploadIapReviewScreenshotTool,
  submitIapForReviewTool,
];
