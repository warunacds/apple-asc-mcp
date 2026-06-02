import type { Tool } from "./registry.js";
import {
  whoamiTool, listAppsTool, getAppTool, listBuildsTool, getBuildTool,
  listVersionsTool, getVersionTool, listLocalizationsTool, listCategoriesTool,
  listTerritoriesTool,
} from "./discovery.js";
import {
  listInAppPurchasesTool, getInAppPurchaseTool, createInAppPurchaseTool, setIapLocalizationTool,
  listIapPricePointsTool, setIapPriceTool, setIapAvailabilityTool, uploadIapReviewScreenshotTool,
  submitIapForReviewTool, deleteInAppPurchaseTool,
} from "./iap.js";
import {
  listSubscriptionGroupsTool, createSubscriptionGroupTool, setSubscriptionGroupLocalizationTool,
  createSubscriptionTool, getSubscriptionTool, setSubscriptionLocalizationTool,
  listSubscriptionPricePointsTool, setSubscriptionPriceTool, setSubscriptionAvailabilityTool,
  setSubscriptionIntroOfferTool, uploadSubscriptionReviewScreenshotTool, submitSubscriptionForReviewTool,
  deleteSubscriptionTool, deleteSubscriptionGroupTool,
} from "./subscriptions.js";
import {
  createVersionTool, updateVersionTool, attachBuildTool, setVersionLocalizationTool,
  releaseToStoreTool, setPhasedReleaseTool, getEditableAppInfoTool, setAppCategoriesTool,
  setAppInfoLocalizationTool, setReviewDetailsTool,
} from "./metadata.js";
import { listAppPricePointsTool, getAppPriceScheduleTool, setAppPriceTool } from "./pricing.js";
import { setContentRightsTool, getAgeRatingTool, setAgeRatingTool } from "./compliance.js";
import {
  listPromotionalOffersTool, createPromotionalOfferTool, addPromotionalOfferPriceTool, deletePromotionalOfferTool,
} from "./offers.js";
import {
  listScreenshotSetsTool, findOrCreateScreenshotSetTool, uploadScreenshotTool,
  deleteScreenshotTool, reorderScreenshotsTool, findOrCreatePreviewSetTool, uploadPreviewTool,
} from "./screenshots.js";
import { uploadIpaTool, validateIpaTool, waitForBuildTool } from "./upload.js";
import { xcArchiveTool, xcExportTool } from "./xcode_tools.js";
import { submitForReviewTool, getReviewSubmissionTool, listReviewSubmissionsTool, cancelReviewSubmissionTool } from "./reviews.js";
import { listBetaGroupsTool, setBetaWhatsNewTool, distributeToBetaGroupsTool, submitForBetaReviewTool } from "./testflight.js";
import { releaseStatusTool } from "./status.js";
import {
  listBundleIdsTool, createBundleIdTool, deleteBundleIdTool, enableBundleCapabilityTool,
  disableBundleCapabilityTool, listCertificatesTool, createCertificateTool, revokeCertificateTool,
  listDevicesTool, registerDeviceTool, listProfilesTool, createProfileTool, deleteProfileTool,
} from "./provisioning.js";
import {
  getAppAvailabilityTool, setAppAvailabilityTool, listEncryptionDeclarationsTool,
  createEncryptionDeclarationTool, assignEncryptionDeclarationTool,
} from "./submission.js";
import { listCustomerReviewsTool, getCustomerReviewTool, respondToReviewTool, deleteReviewResponseTool } from "./reviews_customer.js";
import {
  listOfferCodesTool, createOfferCodeTool, createOfferCodeCustomCodesTool,
  createOfferCodeOneTimeCodesTool, listWinBackOffersTool, createWinBackOfferTool, deleteWinBackOfferTool,
} from "./offer_codes.js";
import {
  listWebhooksTool, createWebhookTool, updateWebhookTool, deleteWebhookTool, pingWebhookTool, listWebhookDeliveriesTool,
} from "./webhooks.js";
import {
  listUsersTool, getUserTool, updateUserTool, listUserInvitationsTool, inviteUserTool, cancelUserInvitationTool,
} from "./users.js";
import {
  listCiProductsTool, listCiWorkflowsTool, getCiWorkflowTool, startCiBuildTool, listCiBuildRunsTool, getCiBuildRunTool,
} from "./xcode_cloud.js";
import {
  getSalesReportTool, getFinanceReportTool, requestAnalyticsReportTool, listAnalyticsReportsTool,
} from "./reports.js";
import {
  getGameCenterDetailTool, listAchievementsTool, createAchievementTool, setAchievementLocalizationTool,
  listLeaderboardsTool, createLeaderboardTool, setLeaderboardLocalizationTool,
} from "./gamecenter.js";
import {
  getAltDistributionKeyTool, createAltDistributionKeyTool, listAltDistributionPackagesTool,
  listMarketplaceDomainsTool, createMarketplaceDomainTool,
} from "./alt_distribution.js";

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
  submitIapForReviewTool, deleteInAppPurchaseTool,

  // Auto-renewable subscriptions
  listSubscriptionGroupsTool, createSubscriptionGroupTool, setSubscriptionGroupLocalizationTool,
  createSubscriptionTool, getSubscriptionTool, setSubscriptionLocalizationTool,
  listSubscriptionPricePointsTool, setSubscriptionPriceTool, setSubscriptionAvailabilityTool,
  setSubscriptionIntroOfferTool, uploadSubscriptionReviewScreenshotTool, submitSubscriptionForReviewTool,
  deleteSubscriptionTool, deleteSubscriptionGroupTool,

  // Subscription promotional offers
  listPromotionalOffersTool, createPromotionalOfferTool, addPromotionalOfferPriceTool, deletePromotionalOfferTool,

  // Provisioning / code signing
  listBundleIdsTool, createBundleIdTool, deleteBundleIdTool, enableBundleCapabilityTool,
  disableBundleCapabilityTool, listCertificatesTool, createCertificateTool, revokeCertificateTool,
  listDevicesTool, registerDeviceTool, listProfilesTool, createProfileTool, deleteProfileTool,

  // Submission gates (app availability, export compliance)
  getAppAvailabilityTool, setAppAvailabilityTool, listEncryptionDeclarationsTool,
  createEncryptionDeclarationTool, assignEncryptionDeclarationTool,

  // Customer reviews + developer responses
  listCustomerReviewsTool, getCustomerReviewTool, respondToReviewTool, deleteReviewResponseTool,

  // Subscription offer codes + win-back offers
  listOfferCodesTool, createOfferCodeTool, createOfferCodeCustomCodesTool,
  createOfferCodeOneTimeCodesTool, listWinBackOffersTool, createWinBackOfferTool, deleteWinBackOfferTool,

  // Webhooks
  listWebhooksTool, createWebhookTool, updateWebhookTool, deleteWebhookTool, pingWebhookTool, listWebhookDeliveriesTool,

  // Users & access
  listUsersTool, getUserTool, updateUserTool, listUserInvitationsTool, inviteUserTool, cancelUserInvitationTool,

  // Xcode Cloud
  listCiProductsTool, listCiWorkflowsTool, getCiWorkflowTool, startCiBuildTool, listCiBuildRunsTool, getCiBuildRunTool,

  // Reporting (sales / finance / analytics)
  getSalesReportTool, getFinanceReportTool, requestAnalyticsReportTool, listAnalyticsReportsTool,

  // Game Center
  getGameCenterDetailTool, listAchievementsTool, createAchievementTool, setAchievementLocalizationTool,
  listLeaderboardsTool, createLeaderboardTool, setLeaderboardLocalizationTool,

  // Alternative distribution (EU DMA)
  getAltDistributionKeyTool, createAltDistributionKeyTool, listAltDistributionPackagesTool,
  listMarketplaceDomainsTool, createMarketplaceDomainTool,
];
