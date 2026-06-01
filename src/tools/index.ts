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
  listSubscriptionGroupsTool, createSubscriptionGroupTool, setSubscriptionGroupLocalizationTool,
  createSubscriptionTool, getSubscriptionTool, setSubscriptionLocalizationTool,
  listSubscriptionPricePointsTool, setSubscriptionPriceTool, setSubscriptionAvailabilityTool,
  setSubscriptionIntroOfferTool, uploadSubscriptionReviewScreenshotTool, submitSubscriptionForReviewTool,
} from "./subscriptions.js";
import {
  createVersionTool, updateVersionTool, attachBuildTool, setVersionLocalizationTool,
  releaseToStoreTool, setPhasedReleaseTool, getEditableAppInfoTool, setAppCategoriesTool,
  setAppInfoLocalizationTool, setReviewDetailsTool,
} from "./metadata.js";
import { listAppPricePointsTool, getAppPriceScheduleTool, setAppPriceTool } from "./pricing.js";
import { setContentRightsTool, getAgeRatingTool, setAgeRatingTool } from "./compliance.js";
import {
  listPrivacyOptionsTool, getPrivacyDetailsTool, addDataUsageTool, removeDataUsageTool,
  declareNoDataCollectedTool, publishPrivacyTool,
} from "./privacy.js";
import {
  listScreenshotSetsTool, findOrCreateScreenshotSetTool, uploadScreenshotTool,
  deleteScreenshotTool, reorderScreenshotsTool, findOrCreatePreviewSetTool, uploadPreviewTool,
} from "./screenshots.js";
import { uploadIpaTool, validateIpaTool, waitForBuildTool } from "./upload.js";
import { xcArchiveTool, xcExportTool } from "./xcode_tools.js";
import { submitForReviewTool, getReviewSubmissionTool, listReviewSubmissionsTool, cancelReviewSubmissionTool } from "./reviews.js";
import { listCustomerReviewsTool, getCustomerReviewTool, respondToReviewTool, deleteReviewResponseTool } from "./reviews_customer.js";
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
  releaseToStoreTool, setPhasedReleaseTool, getEditableAppInfoTool, setAppCategoriesTool,
  setAppInfoLocalizationTool, setReviewDetailsTool,

  // App pricing
  listAppPricePointsTool, getAppPriceScheduleTool, setAppPriceTool,

  // Compliance declarations (content rights, age rating)
  setContentRightsTool, getAgeRatingTool, setAgeRatingTool,

  // App privacy ("nutrition label")
  listPrivacyOptionsTool, getPrivacyDetailsTool, addDataUsageTool, removeDataUsageTool,
  declareNoDataCollectedTool, publishPrivacyTool,

  // Screenshots & previews
  listScreenshotSetsTool, findOrCreateScreenshotSetTool, uploadScreenshotTool,
  deleteScreenshotTool, reorderScreenshotsTool, findOrCreatePreviewSetTool, uploadPreviewTool,

  // Review submission (the modern reviewSubmissions API)
  submitForReviewTool, getReviewSubmissionTool, listReviewSubmissionsTool, cancelReviewSubmissionTool,

  // Customer reviews + developer responses
  listCustomerReviewsTool, getCustomerReviewTool, respondToReviewTool, deleteReviewResponseTool,

  // TestFlight
  listBetaGroupsTool, setBetaWhatsNewTool, distributeToBetaGroupsTool, submitForBetaReviewTool,

  // In-App Purchases (v2)
  listInAppPurchasesTool, getInAppPurchaseTool, createInAppPurchaseTool, setIapLocalizationTool,
  listIapPricePointsTool, setIapPriceTool, setIapAvailabilityTool, uploadIapReviewScreenshotTool,
  submitIapForReviewTool,

  // Auto-renewable subscriptions
  listSubscriptionGroupsTool, createSubscriptionGroupTool, setSubscriptionGroupLocalizationTool,
  createSubscriptionTool, getSubscriptionTool, setSubscriptionLocalizationTool,
  listSubscriptionPricePointsTool, setSubscriptionPriceTool, setSubscriptionAvailabilityTool,
  setSubscriptionIntroOfferTool, uploadSubscriptionReviewScreenshotTool, submitSubscriptionForReviewTool,
];
