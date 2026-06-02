import { z } from "zod";
import { tool } from "./registry.js";
import type { SubscriptionPricePointAttrs } from "../types.js";

/**
 * Subscription offer codes and win-back offers — the remaining subscription-offer types beyond
 * introductory offers (in subscriptions.ts) and promotional offers (in offers.ts, separate PR).
 *
 * - Offer codes: redeemable codes (a reusable "custom code", or batches of unique "one-time-use" codes)
 *   that grant a discount to NEW / EXISTING / EXPIRED subscribers.
 * - Win-back offers: surfaced by the App Store to lapsed subscribers (2024+).
 *
 * Write shapes cross-checked against the App Store Connect OpenAPI spec (round-4 audit): offer codes
 * require `offerEligibility` and a price; win-back offers require customer-eligibility windows + priority.
 */

const OFFER_DURATIONS = ["THREE_DAYS", "ONE_WEEK", "TWO_WEEKS", "ONE_MONTH", "TWO_MONTHS", "THREE_MONTHS", "SIX_MONTHS", "ONE_YEAR"] as const;
const OFFER_MODES = ["FREE_TRIAL", "PAY_AS_YOU_GO", "PAY_UP_FRONT"] as const;
const ELIGIBILITIES = ["NEW", "EXISTING", "EXPIRED"] as const;
const OFFER_ELIGIBILITIES = ["STACK_WITH_INTRO_OFFERS", "REPLACE_INTRO_OFFERS"] as const;
const WIN_BACK_PRIORITIES = ["HIGH", "NORMAL"] as const;
const PROMOTION_INTENTS = ["NOT_PROMOTED", "USE_AUTO_GENERATED_ASSETS"] as const;

async function resolvePricePoint(
  client: import("../client.js").AscClient,
  subscriptionId: string,
  territory: string,
  customerPrice: string | undefined,
): Promise<string> {
  const points = await client.list<SubscriptionPricePointAttrs>(`/v1/subscriptions/${subscriptionId}/pricePoints`, {
    "filter[territory]": territory,
    limit: 200,
    "fields[subscriptionPricePoints]": "customerPrice,proceeds",
  });
  const match = points.find((p) => p.attributes?.customerPrice === customerPrice);
  if (!match) {
    const sample = points.slice(0, 12).map((p) => p.attributes?.customerPrice).filter(Boolean).join(", ");
    throw new Error(
      `No price point with customerPrice="${customerPrice}" in ${territory}. Available include: ${sample}… ` +
      `Use asc_list_subscription_price_points for the full list, then pass pricePointId.`,
    );
  }
  return match.id;
}

/** Build the inline-price body fragment shared by offer codes and win-back offers (paid modes only). */
function inlinePrice(pricePointId: string, territory: string, priceType: string, lid: string) {
  return {
    rel: { data: [{ type: priceType, id: lid }] },
    included: {
      type: priceType,
      id: lid,
      relationships: {
        subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: pricePointId } },
        territory: { data: { type: "territories", id: territory } },
      },
    },
  };
}

// ── Offer codes ──────────────────────────────────────────────────────────────

export const listOfferCodesTool = tool({
  name: "asc_list_offer_codes",
  description: "List the offer codes configured on a subscription (id, name, customerEligibilities, duration, offerMode, active).",
  inputSchema: z.object({ subscriptionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const codes = await client.list(`/v1/subscriptions/${input.subscriptionId}/offerCodes`, {
      limit: 200,
      "fields[subscriptionOfferCodes]": "name,customerEligibilities,offerEligibility,duration,offerMode,numberOfPeriods,active",
    });
    return codes.map((c) => ({ id: c.id, ...c.attributes }));
  },
});

export const createOfferCodeTool = tool({
  name: "asc_create_offer_code",
  description:
    "Create an offer code on a subscription. customerEligibilities chooses who can redeem (NEW / EXISTING / EXPIRED); " +
    "offerEligibility says how it interacts with intro offers (STACK_WITH_INTRO_OFFERS / REPLACE_INTRO_OFFERS). " +
    "A price is always required (the price point the offer is tied to) — pass customerPrice (resolved in baseTerritory) or pricePointId. " +
    "After creating, generate redeemable codes with asc_create_offer_code_custom_codes or asc_create_offer_code_one_time_codes.",
  inputSchema: z.object({
    subscriptionId: z.string(),
    name: z.string().describe("Reference name shown in App Store Connect."),
    customerEligibilities: z.array(z.enum(ELIGIBILITIES)).min(1),
    offerEligibility: z.enum(OFFER_ELIGIBILITIES).describe("How the offer interacts with introductory offers."),
    offerMode: z.enum(OFFER_MODES),
    duration: z.enum(OFFER_DURATIONS),
    numberOfPeriods: z.number().int().min(1).default(1),
    baseTerritory: z.string().default("USA"),
    customerPrice: z.string().optional(),
    pricePointId: z.string().optional(),
  }).strict().refine(
    (v) => !!v.customerPrice || !!v.pricePointId,
    { message: "Offer codes need a price: pass customerPrice or pricePointId." },
  ),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {
      name: input.name,
      customerEligibilities: input.customerEligibilities,
      offerEligibility: input.offerEligibility,
      offerMode: input.offerMode,
      duration: input.duration,
      numberOfPeriods: input.numberOfPeriods,
    };
    const relationships: Record<string, unknown> = { subscription: { data: { type: "subscriptions", id: input.subscriptionId } } };
    const pricePointId = input.pricePointId ?? (await resolvePricePoint(client, input.subscriptionId, input.baseTerritory, input.customerPrice));
    const p = inlinePrice(pricePointId, input.baseTerritory, "subscriptionOfferCodePrices", "${offer-code-price-1}");
    relationships.prices = p.rel;
    const body = { data: { type: "subscriptionOfferCodes", attributes, relationships }, included: [p.included] };
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/subscriptionOfferCodes", body);
    return { ok: true, offerCodeId: res.data.id, ...res.data.attributes };
  },
});

export const createOfferCodeCustomCodesTool = tool({
  name: "asc_create_offer_code_custom_codes",
  description:
    "Generate a custom (memorable) redeemable code for an offer code — one string usable up to numberOfCodes times " +
    "until expirationDate. Get the offerCodeId from asc_create_offer_code / asc_list_offer_codes.",
  inputSchema: z.object({
    offerCodeId: z.string(),
    customCode: z.string().describe("The memorable code string, e.g. WELCOME2026."),
    numberOfCodes: z.number().int().min(1),
    expirationDate: z.string().optional().describe("ISO date the code stops working."),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = { customCode: input.customCode, numberOfCodes: input.numberOfCodes };
    if (input.expirationDate) attributes.expirationDate = input.expirationDate;
    const res = await client.post<{ data: { id: string } }>("/v1/subscriptionOfferCodeCustomCodes", {
      data: {
        type: "subscriptionOfferCodeCustomCodes",
        attributes,
        relationships: { offerCode: { data: { type: "subscriptionOfferCodes", id: input.offerCodeId } } },
      },
    });
    return { ok: true, customCodeId: res.data.id, customCode: input.customCode };
  },
});

export const createOfferCodeOneTimeCodesTool = tool({
  name: "asc_create_offer_code_one_time_codes",
  description:
    "Generate a batch of unique one-time-use redeemable codes for an offer code (each code redeemable once). " +
    "Apple generates numberOfCodes codes; the values are downloaded from App Store Connect.",
  inputSchema: z.object({
    offerCodeId: z.string(),
    numberOfCodes: z.number().int().min(1).max(50000),
    expirationDate: z.string().describe("ISO date the generated codes stop working (required by Apple)."),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = { numberOfCodes: input.numberOfCodes, expirationDate: input.expirationDate };
    const res = await client.post<{ data: { id: string } }>("/v1/subscriptionOfferCodeOneTimeUseCodes", {
      data: {
        type: "subscriptionOfferCodeOneTimeUseCodes",
        attributes,
        relationships: { offerCode: { data: { type: "subscriptionOfferCodes", id: input.offerCodeId } } },
      },
    });
    return { ok: true, batchId: res.data.id, numberOfCodes: input.numberOfCodes, note: "Download the generated code values from App Store Connect (not exposed individually via API)." };
  },
});

// ── Win-back offers ──────────────────────────────────────────────────────────

export const listWinBackOffersTool = tool({
  name: "asc_list_win_back_offers",
  description: "List the win-back offers on a subscription (offers the App Store surfaces to lapsed subscribers).",
  inputSchema: z.object({ subscriptionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const offers = await client.list(`/v1/subscriptions/${input.subscriptionId}/winBackOffers`, { limit: 200 });
    return offers.map((o) => ({ id: o.id, ...o.attributes }));
  },
});

export const createWinBackOfferTool = tool({
  name: "asc_create_win_back_offer",
  description:
    "Create a win-back offer (shown by the App Store to previously-subscribed, now-lapsed users). offerId is the " +
    "developer-defined identifier. Apple requires the eligibility window (how long they paid, and how long since they " +
    "lapsed), a priority, a start date, and a price — pass customerPrice (resolved in baseTerritory) or pricePointId.",
  inputSchema: z.object({
    subscriptionId: z.string(),
    referenceName: z.string(),
    offerId: z.string().describe("Developer-defined win-back offer identifier."),
    offerMode: z.enum(OFFER_MODES),
    duration: z.enum(OFFER_DURATIONS),
    periodCount: z.number().int().min(1).default(1),
    priority: z.enum(WIN_BACK_PRIORITIES).describe("HIGH offers are surfaced ahead of NORMAL ones."),
    customerEligibilityPaidSubscriptionDurationInMonths: z.number().int().min(0)
      .describe("Minimum months the user must previously have paid to qualify."),
    timeSinceLastSubscribedMonths: z.object({ minimum: z.number().int().min(0), maximum: z.number().int().min(0) })
      .describe("Window since the user last subscribed, in months (minimum/maximum)."),
    customerEligibilityWaitBetweenOffersInMonths: z.number().int().min(0).optional(),
    promotionIntent: z.enum(PROMOTION_INTENTS).optional()
      .describe("USE_AUTO_GENERATED_ASSETS lets the App Store promote the offer with generated assets."),
    startDate: z.string().describe("ISO date the offer becomes available."),
    endDate: z.string().optional(),
    baseTerritory: z.string().default("USA"),
    customerPrice: z.string().optional(),
    pricePointId: z.string().optional(),
  }).strict().refine(
    (v) => !!v.customerPrice || !!v.pricePointId,
    { message: "Win-back offers need a price: pass customerPrice or pricePointId." },
  ),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {
      referenceName: input.referenceName,
      offerId: input.offerId,
      offerMode: input.offerMode,
      duration: input.duration,
      periodCount: input.periodCount,
      priority: input.priority,
      customerEligibilityPaidSubscriptionDurationInMonths: input.customerEligibilityPaidSubscriptionDurationInMonths,
      customerEligibilityTimeSinceLastSubscribedInMonths: {
        minimum: input.timeSinceLastSubscribedMonths.minimum,
        maximum: input.timeSinceLastSubscribedMonths.maximum,
      },
      startDate: input.startDate,
    };
    if (input.customerEligibilityWaitBetweenOffersInMonths !== undefined) {
      attributes.customerEligibilityWaitBetweenOffersInMonths = input.customerEligibilityWaitBetweenOffersInMonths;
    }
    if (input.promotionIntent) attributes.promotionIntent = input.promotionIntent;
    if (input.endDate) attributes.endDate = input.endDate;
    const relationships: Record<string, unknown> = { subscription: { data: { type: "subscriptions", id: input.subscriptionId } } };
    const pricePointId = input.pricePointId ?? (await resolvePricePoint(client, input.subscriptionId, input.baseTerritory, input.customerPrice));
    const p = inlinePrice(pricePointId, input.baseTerritory, "winBackOfferPrices", "${win-back-price-1}");
    relationships.prices = p.rel;
    const body = { data: { type: "winBackOffers", attributes, relationships }, included: [p.included] };
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/winBackOffers", body);
    return { ok: true, winBackOfferId: res.data.id, offerId: input.offerId, ...res.data.attributes };
  },
});

export const deleteWinBackOfferTool = tool({
  name: "asc_delete_win_back_offer",
  description:
    "Delete a win-back offer by id (DELETE /v1/winBackOffers/{id}). Find ids via asc_list_win_back_offers. " +
    "Mirrors asc_delete_promotional_offer for the other lapsed-subscriber offer type.",
  inputSchema: z.object({ winBackOfferId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/winBackOffers/${input.winBackOfferId}`);
    return { ok: true, deleted: input.winBackOfferId };
  },
});
