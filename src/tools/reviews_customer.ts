import { z } from "zod";
import { tool } from "./registry.js";

/**
 * Customer reviews — read App Store reviews and post/edit/delete the developer response.
 * (Distinct from src/tools/reviews.ts, which is the App Review *submission* flow.)
 *
 * Reading reviews needs no special role; posting responses may require a higher role. Not validated
 * against live Apple traffic; shapes inferred and marked [VERIFY].
 */

interface CustomerReviewAttrs {
  rating?: number;
  title?: string;
  body?: string;
  reviewerNickname?: string;
  createdDate?: string;
  territory?: string;
}

export const listCustomerReviewsTool = tool({
  name: "asc_list_customer_reviews",
  description:
    "List App Store customer reviews for an app. Filter by territory or rating; sort by date or rating " +
    "(default newest first). Returns rating, title, body, reviewerNickname, createdDate, territory.",
  inputSchema: z.object({
    appId: z.string(),
    territory: z.string().optional().describe("Territory code filter, e.g. USA."),
    rating: z.number().int().min(1).max(5).optional().describe("Filter to a specific star rating."),
    sort: z.enum(["-createdDate", "createdDate", "-rating", "rating"]).default("-createdDate"),
    limit: z.number().int().min(1).max(200).default(50).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const q: Record<string, string | number | undefined> = {
      sort: input.sort,
      limit: input.limit ?? 50,
      "fields[customerReviews]": "rating,title,body,reviewerNickname,createdDate,territory",
    };
    if (input.territory) q["filter[territory]"] = input.territory;
    if (input.rating !== undefined) q["filter[rating]"] = input.rating;
    const reviews = await client.list<CustomerReviewAttrs>(`/v1/apps/${input.appId}/customerReviews`, q);
    return reviews.map((r) => ({ id: r.id, ...r.attributes }));
  },
});

export const getCustomerReviewTool = tool({
  name: "asc_get_customer_review",
  description: "Read a single customer review and its existing developer response (if any).",
  inputSchema: z.object({ reviewId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.get(`/v1/customerReviews/${input.reviewId}`, {
      query: { include: "response", "fields[customerReviews]": "rating,title,body,reviewerNickname,createdDate,territory" },
    });
  },
});

export const respondToReviewTool = tool({
  name: "asc_respond_to_review",
  description:
    "Post or update the developer response to a customer review (upsert: PATCHes the existing response if there is " +
    "one, otherwise creates it). Find review ids via asc_list_customer_reviews.",
  inputSchema: z.object({
    reviewId: z.string(),
    responseBody: z.string().min(1).max(5970).describe("The public response text."),
  }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] the existing response is reachable at /v1/customerReviews/{id}/response.
    const existing = await client
      .get<{ data?: { id: string } | null }>(`/v1/customerReviews/${input.reviewId}/response`)
      .catch(() => ({ data: null }));
    if (existing && existing.data) {
      const id = existing.data.id;
      const res = await client.patch(`/v1/customerReviewResponses/${id}`, {
        data: { type: "customerReviewResponses", id, attributes: { responseBody: input.responseBody } },
      });
      return { action: "updated", id, result: res };
    }
    const res = await client.post<{ data: { id: string } }>("/v1/customerReviewResponses", {
      data: {
        type: "customerReviewResponses",
        attributes: { responseBody: input.responseBody },
        relationships: { review: { data: { type: "customerReviews", id: input.reviewId } } },
      },
    });
    return { action: "created", id: res.data.id };
  },
});

export const deleteReviewResponseTool = tool({
  name: "asc_delete_review_response",
  description: "Delete a developer response to a customer review. Pass the response id (from asc_get_customer_review).",
  inputSchema: z.object({ responseId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/customerReviewResponses/${input.responseId}`);
    return { ok: true, responseId: input.responseId };
  },
});
