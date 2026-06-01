import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Review submission flow (the modern path that replaced /v1/appStoreVersionSubmissions):
 *   1. POST /v1/reviewSubmissions { app, platform }            → creates draft submission
 *   2. POST /v1/reviewSubmissionItems { reviewSubmission, appStoreVersion } (per item)
 *   3. PATCH /v1/reviewSubmissions/{id} { submitted: true }    → finalizes & sends to Apple
 */

export const submitForReviewTool = tool({
  name: "asc_submit_for_review",
  description:
    "End-to-end review submission: creates a reviewSubmission, adds the version as an item, and PATCHes submitted=true. " +
    "Returns the submission id and final state. The version must already have a build attached, all required localizations + screenshots, and review details set.",
  inputSchema: z.object({
    appId: z.string(),
    versionId: z.string().describe("App Store Version id to submit."),
    platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).default("IOS"),
    additionalItems: z.array(z.object({
      type: z.enum([
        "inAppPurchaseV2",
        "appCustomProductPageVersion","appStoreVersionExperimentV2","appStoreVersionExperiment",
        "appEvent","backgroundAssetVersion","gameCenterAchievementVersion","gameCenterActivityVersion",
        "gameCenterChallengeVersion","gameCenterLeaderboardSetVersion","gameCenterLeaderboardVersion",
      ]),
      id: z.string(),
    })).optional().describe("Additional reviewable resources to bundle into the same submission (e.g. an in-app purchase: {type:\"inAppPurchaseV2\", id}). Alternatively submit an IAP on its own with asc_submit_iap_for_review."),
  }).strict(),
  handler: async (input, { client }) => {
    const draft = await client.post<{ data: { id: string } }>("/v1/reviewSubmissions", {
      data: {
        type: "reviewSubmissions",
        attributes: { platform: input.platform },
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    });
    const submissionId = draft.data.id;

    // A reviewSubmissionItem's relationship name is singular (e.g. inAppPurchaseV2) but the JSON:API
    // resource type it points at differs where the names don't coincide. Map the known exceptions.
    const REL_RESOURCE_TYPE: Record<string, string> = { inAppPurchaseV2: "inAppPurchases" };
    const items: { type: string; id: string; relName: string }[] = [
      { type: "appStoreVersions", id: input.versionId, relName: "appStoreVersion" },
      ...(input.additionalItems ?? []).map((it) => ({ type: REL_RESOURCE_TYPE[it.type] ?? it.type, id: it.id, relName: it.type })),
    ];
    const itemIds: string[] = [];
    for (const it of items) {
      const created = await client.post<{ data: { id: string } }>("/v1/reviewSubmissionItems", {
        data: {
          type: "reviewSubmissionItems",
          relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
            [it.relName]: { data: { type: it.type, id: it.id } },
          },
        },
      });
      itemIds.push(created.data.id);
    }

    const finalRes = await client.patch<{ data: { id: string; attributes: { state?: string; submittedDate?: string } } }>(
      `/v1/reviewSubmissions/${submissionId}`,
      { data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } } },
    );

    return {
      ok: true,
      submissionId,
      itemIds,
      state: finalRes.data.attributes?.state,
      submittedDate: finalRes.data.attributes?.submittedDate,
    };
  },
});

export const getReviewSubmissionTool = tool({
  name: "asc_get_review_submission",
  description: "Read a review submission's state and items. State values: READY_FOR_REVIEW, WAITING_FOR_REVIEW, IN_REVIEW, UNRESOLVED_ISSUES, CANCELING, COMPLETING, COMPLETE.",
  inputSchema: z.object({ submissionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const res = await client.get(`/v1/reviewSubmissions/${input.submissionId}`, {
      query: { include: "items", "fields[reviewSubmissions]": "platform,submittedDate,state,lastUpdatedByActor" },
    });
    return res;
  },
});

export const listReviewSubmissionsTool = tool({
  name: "asc_list_review_submissions",
  description: "List review submissions for an app. filter[app] is required.",
  inputSchema: z.object({
    appId: z.string(),
    state: z.string().optional(),
    platform: z.enum(["IOS", "MAC_OS", "TV_OS", "VISION_OS"]).optional(),
    limit: z.number().int().min(1).max(200).default(20),
  }).strict(),
  handler: async (input, { client }) => {
    const q: Record<string, string | number> = {
      "filter[app]": input.appId,
      limit: input.limit,
      "fields[reviewSubmissions]": "platform,submittedDate,state",
    };
    if (input.state) q["filter[state]"] = input.state;
    if (input.platform) q["filter[platform]"] = input.platform;
    return await client.list("/v1/reviewSubmissions", q);
  },
});

export const cancelReviewSubmissionTool = tool({
  name: "asc_cancel_review_submission",
  description: "Pull a submission back. Only works while state is in flight (not COMPLETE).",
  inputSchema: z.object({ submissionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.patch(`/v1/reviewSubmissions/${input.submissionId}`, {
      data: { type: "reviewSubmissions", id: input.submissionId, attributes: { canceled: true } },
    });
  },
});
