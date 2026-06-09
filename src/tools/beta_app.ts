import { z } from "zod";
import { tool } from "./registry.js";

/**
 * App-level TestFlight configuration: per-locale beta app metadata (description, feedback email,
 * marketing/privacy URLs), the beta app review flow (submissions + the demo/contact details Apple
 * reviewers use), and the beta license agreement testers must accept.
 *
 * Build submission lives elsewhere — use the existing asc_submit_for_beta_review to send a build for
 * external TestFlight review. The review *details* here (asc_*_beta_app_review_details) are the
 * demo-account and contact info attached to that submission, not the submission itself.
 *
 * Note the asymmetric review-details paths: read is app-scoped (/v1/apps/:id/betaAppReviewDetail,
 * singular relationship), write is by detail id (/v1/betaAppReviewDetails/:id, plural). [VERIFY] this
 * pair against live Apple traffic. The whole server is unvalidated against live traffic; shapes here
 * are taken from the App Store Connect API surface and marked [VERIFY] where inferred.
 */

const BETA_REVIEW_STATES = ["WAITING_FOR_REVIEW", "IN_REVIEW", "REJECTED", "APPROVED"] as const;

// ── Beta app localizations ────────────────────────────────────────────────────

export const listBetaAppLocalizationsTool = tool({
  name: "asc_list_beta_app_localizations",
  description: "List the per-locale TestFlight app metadata for an app (locale, description, feedbackEmail, marketingUrl, privacyPolicyUrl, tvOsPrivacyPolicy).",
  inputSchema: z.object({
    appId: z.string(),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const rows = await client.list(`/v1/apps/${input.appId}/betaAppLocalizations`, {
      limit: input.limit ?? 100,
      "fields[betaAppLocalizations]": "locale,description,feedbackEmail,marketingUrl,privacyPolicyUrl,tvOsPrivacyPolicy",
    });
    return rows.map((r) => ({ id: r.id, ...r.attributes }));
  },
});

export const createBetaAppLocalizationTool = tool({
  name: "asc_create_beta_app_localization",
  description:
    "Create a TestFlight app localization for one locale (the testers-facing description, feedback email, and URLs). " +
    "One per locale per app; use asc_update_beta_app_localization to change an existing one.",
  inputSchema: z.object({
    appId: z.string(),
    locale: z.string().describe("e.g. en-US, ja, de-DE."),
    description: z.string().optional().describe("Tester-facing app description shown in TestFlight."),
    feedbackEmail: z.string().optional(),
    marketingUrl: z.string().optional(),
    privacyPolicyUrl: z.string().optional(),
    tvOsPrivacyPolicy: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = { locale: input.locale };
    for (const k of ["description", "feedbackEmail", "marketingUrl", "privacyPolicyUrl", "tvOsPrivacyPolicy"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    return await client.post("/v1/betaAppLocalizations", {
      data: {
        type: "betaAppLocalizations",
        attributes,
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    });
  },
});

export const getBetaAppLocalizationTool = tool({
  name: "asc_get_beta_app_localization",
  description: "Get a single TestFlight app localization by id.",
  inputSchema: z.object({ localizationId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.get(`/v1/betaAppLocalizations/${input.localizationId}`);
  },
});

export const updateBetaAppLocalizationTool = tool({
  name: "asc_update_beta_app_localization",
  description: "Update a TestFlight app localization (description, feedbackEmail, marketingUrl, privacyPolicyUrl, tvOsPrivacyPolicy). Only the fields you pass change.",
  inputSchema: z.object({
    localizationId: z.string(),
    description: z.string().optional(),
    feedbackEmail: z.string().optional(),
    marketingUrl: z.string().optional(),
    privacyPolicyUrl: z.string().optional(),
    tvOsPrivacyPolicy: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {};
    for (const k of ["description", "feedbackEmail", "marketingUrl", "privacyPolicyUrl", "tvOsPrivacyPolicy"] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    if (Object.keys(attributes).length === 0) throw new Error("Pass at least one field to update.");
    return await client.patch(`/v1/betaAppLocalizations/${input.localizationId}`, {
      data: { type: "betaAppLocalizations", id: input.localizationId, attributes },
    });
  },
});

export const deleteBetaAppLocalizationTool = tool({
  name: "asc_delete_beta_app_localization",
  description: "Delete a TestFlight app localization by id.",
  inputSchema: z.object({ localizationId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/betaAppLocalizations/${input.localizationId}`);
    return { ok: true, localizationId: input.localizationId };
  },
});

// ── Beta app review ───────────────────────────────────────────────────────────

export const listBetaAppReviewSubmissionsTool = tool({
  name: "asc_list_beta_app_review_submissions",
  description: "List beta app review submissions for a build (filter[build]), optionally narrowed to a review state.",
  inputSchema: z.object({
    buildId: z.string(),
    reviewState: z.enum(BETA_REVIEW_STATES).optional().describe("Narrow to WAITING_FOR_REVIEW / IN_REVIEW / REJECTED / APPROVED."),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const query: Record<string, string | number> = {
      "filter[build]": input.buildId,
      limit: input.limit ?? 100,
    };
    if (input.reviewState) query["filter[betaReviewState]"] = input.reviewState;
    const rows = await client.list(`/v1/betaAppReviewSubmissions`, query);
    return rows.map((r) => ({ id: r.id, ...r.attributes }));
  },
});

export const getBetaAppReviewSubmissionTool = tool({
  name: "asc_get_beta_app_review_submission",
  description: "Get a single beta app review submission by id.",
  inputSchema: z.object({ submissionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.get(`/v1/betaAppReviewSubmissions/${input.submissionId}`);
  },
});

export const getBetaAppReviewDetailsTool = tool({
  name: "asc_get_beta_app_review_details",
  description:
    "Get the beta app review details for an app — the demo account and contact info Apple reviewers use for external " +
    "TestFlight review. The returned id is what asc_update_beta_app_review_details takes.",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] read is the app-scoped singular relationship (betaAppReviewDetail); write is by id (plural).
    return await client.get(`/v1/apps/${input.appId}/betaAppReviewDetail`);
  },
});

export const updateBetaAppReviewDetailsTool = tool({
  name: "asc_update_beta_app_review_details",
  description:
    "Update the beta app review details (contact info and demo account) for external TestFlight review. Get the " +
    "reviewDetailId from asc_get_beta_app_review_details. Only the fields you pass change.",
  inputSchema: z.object({
    reviewDetailId: z.string(),
    contactFirstName: z.string().optional(),
    contactLastName: z.string().optional(),
    contactPhone: z.string().optional(),
    contactEmail: z.string().optional(),
    demoAccountName: z.string().optional(),
    demoAccountPassword: z.string().optional(),
    demoAccountRequired: z.boolean().optional(),
    notes: z.string().optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {};
    for (const k of [
      "contactFirstName", "contactLastName", "contactPhone", "contactEmail",
      "demoAccountName", "demoAccountPassword", "demoAccountRequired", "notes",
    ] as const) {
      if (input[k] !== undefined) attributes[k] = input[k];
    }
    if (Object.keys(attributes).length === 0) throw new Error("Pass at least one field to update.");
    return await client.patch(`/v1/betaAppReviewDetails/${input.reviewDetailId}`, {
      data: { type: "betaAppReviewDetails", id: input.reviewDetailId, attributes },
    });
  },
});

// ── Beta license agreements ───────────────────────────────────────────────────

export const listBetaLicenseAgreementsTool = tool({
  name: "asc_list_beta_license_agreements",
  description: "List beta license agreements, optionally filtered to one app (filter[app]). One agreement is auto-created per app.",
  inputSchema: z.object({
    appId: z.string().optional().describe("Filter to a single app's agreement."),
    limit: z.number().int().min(1).max(200).default(100).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const query: Record<string, string | number> = { limit: input.limit ?? 100 };
    if (input.appId) query["filter[app]"] = input.appId;
    const rows = await client.list(`/v1/betaLicenseAgreements`, query);
    return rows.map((r) => ({ id: r.id, ...r.attributes }));
  },
});

export const getBetaLicenseAgreementTool = tool({
  name: "asc_get_beta_license_agreement",
  description: "Get a single beta license agreement by id, including its full agreementText (nullable).",
  inputSchema: z.object({ betaLicenseAgreementId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.get(`/v1/betaLicenseAgreements/${input.betaLicenseAgreementId}`);
  },
});

export const updateBetaLicenseAgreementTool = tool({
  name: "asc_update_beta_license_agreement",
  description: "Update the license agreement text shown to TestFlight testers. Pass agreementText (or null to clear).",
  inputSchema: z.object({
    betaLicenseAgreementId: z.string(),
    agreementText: z.string().nullable().describe("New tester-facing license text; null clears it."),
  }).strict(),
  handler: async (input, { client }) => {
    return await client.patch(`/v1/betaLicenseAgreements/${input.betaLicenseAgreementId}`, {
      data: {
        type: "betaLicenseAgreements",
        id: input.betaLicenseAgreementId,
        attributes: { agreementText: input.agreementText },
      },
    });
  },
});
