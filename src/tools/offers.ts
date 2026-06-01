import { z } from "zod";
import { tool } from "./registry.js";
import type { SubscriptionPricePointAttrs, SubscriptionPromotionalOfferAttrs } from "../types.js";

/**
 * Subscription promotional offers — discounts you present to existing or lapsed subscribers (distinct
 * from introductory offers, which target new subscribers; see asc_set_subscription_intro_offer).
 *
 * An offer carries a developer-defined offerCode (referenced by StoreKit at purchase time), a
 * duration/mode/period, and a discounted price per territory (a subscriptionPromotionalOfferPrice
 * pinned to a subscriptionPricePoint). Prices are created inline with the offer via the placeholder-id
 * pattern, the same shape as the IAP/subscription price tools.
 *
 * Not validated against live Apple traffic; attribute and relationship shapes are inferred and marked
 * [VERIFY]. If a call 400s, the JSON:API error body pins down the exact shape.
 */

const OFFER_DURATIONS = ["THREE_DAYS", "ONE_WEEK", "TWO_WEEKS", "ONE_MONTH", "TWO_MONTHS", "THREE_MONTHS", "SIX_MONTHS", "ONE_YEAR"] as const;
const OFFER_MODES = ["FREE_TRIAL", "PAY_AS_YOU_GO", "PAY_UP_FRONT"] as const;

/** Resolve a subscriptionPricePoint id from a customerPrice in a territory. */
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

export const listPromotionalOffersTool = tool({
  name: "asc_list_promotional_offers",
  description: "List the promotional offers on a subscription (id, name, offerCode, duration, offerMode, numberOfPeriods).",
  inputSchema: z.object({ subscriptionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const offers = await client.list<SubscriptionPromotionalOfferAttrs>(`/v1/subscriptions/${input.subscriptionId}/promotionalOffers`, {
      limit: 200,
      "fields[subscriptionPromotionalOffers]": "name,offerCode,duration,offerMode,numberOfPeriods",
    });
    return offers.map((o) => ({ id: o.id, ...o.attributes }));
  },
});

export const createPromotionalOfferTool = tool({
  name: "asc_create_promotional_offer",
  description:
    "Create a promotional offer on a subscription. offerCode is the developer-defined id StoreKit references at " +
    "purchase. FREE_TRIAL needs no price; PAY_AS_YOU_GO / PAY_UP_FRONT need a discounted price — pass customerPrice " +
    "(resolved in baseTerritory) or an explicit pricePointId. Add prices for more territories with " +
    "asc_add_promotional_offer_price.",
  inputSchema: z.object({
    subscriptionId: z.string(),
    name: z.string().describe("Reference name shown in App Store Connect."),
    offerCode: z.string().describe("Developer-defined offer identifier referenced by StoreKit (unique per subscription)."),
    offerMode: z.enum(OFFER_MODES),
    duration: z.enum(OFFER_DURATIONS).describe("Length of one offer period, e.g. ONE_MONTH."),
    numberOfPeriods: z.number().int().min(1).default(1),
    baseTerritory: z.string().default("USA").describe("Territory the price is set in, e.g. USA."),
    customerPrice: z.string().optional().describe("Discounted price in the base territory, e.g. \"1.99\". Required for paid modes unless pricePointId is given."),
    pricePointId: z.string().optional().describe("Explicit subscriptionPricePoint id (from asc_list_subscription_price_points). Takes precedence over customerPrice."),
  }).strict().refine(
    (v) => v.offerMode === "FREE_TRIAL" || !!v.customerPrice || !!v.pricePointId,
    { message: "Paid promotional offers (PAY_AS_YOU_GO / PAY_UP_FRONT) need customerPrice or pricePointId." },
  ),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {
      name: input.name,
      offerCode: input.offerCode,
      offerMode: input.offerMode,
      duration: input.duration,
      numberOfPeriods: input.numberOfPeriods,
    };
    const relationships: Record<string, unknown> = {
      subscription: { data: { type: "subscriptions", id: input.subscriptionId } },
    };
    const body: { data: Record<string, unknown>; included?: unknown[] } = {
      data: { type: "subscriptionPromotionalOffers", attributes, relationships },
    };

    // [VERIFY] paid offers carry a price per territory (subscriptionPromotionalOfferPrices) created
    // inline via a placeholder id; FREE_TRIAL carries none.
    if (input.offerMode !== "FREE_TRIAL") {
      const pricePointId = input.pricePointId ?? (await resolvePricePoint(client, input.subscriptionId, input.baseTerritory, input.customerPrice));
      const priceLid = "${promo-price-1}";
      relationships.prices = { data: [{ type: "subscriptionPromotionalOfferPrices", id: priceLid }] };
      body.included = [
        {
          type: "subscriptionPromotionalOfferPrices",
          id: priceLid,
          relationships: {
            subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: pricePointId } },
            territory: { data: { type: "territories", id: input.baseTerritory } },
          },
        },
      ];
    }

    const res = await client.post<{ data: { id: string; attributes?: SubscriptionPromotionalOfferAttrs } }>("/v1/subscriptionPromotionalOffers", body);
    return { ok: true, promotionalOfferId: res.data.id, offerCode: input.offerCode, ...res.data.attributes };
  },
});

export const addPromotionalOfferPriceTool = tool({
  name: "asc_add_promotional_offer_price",
  description:
    "Add a discounted price for another territory to an existing promotional offer. Pass customerPrice (resolved in " +
    "that territory) or an explicit pricePointId.",
  inputSchema: z.object({
    promotionalOfferId: z.string(),
    subscriptionId: z.string().describe("The offer's subscription — needed to resolve a customerPrice to a price point."),
    territory: z.string().describe("Territory code, e.g. GBR."),
    customerPrice: z.string().optional(),
    pricePointId: z.string().optional(),
  }).strict().refine((v) => v.customerPrice || v.pricePointId, { message: "Provide customerPrice or pricePointId." }),
  handler: async (input, { client }) => {
    const pricePointId = input.pricePointId ?? (await resolvePricePoint(client, input.subscriptionId, input.territory, input.customerPrice));
    // [VERIFY] standalone add: the price references the offer + price point + territory.
    const res = await client.post<{ data: { id: string } }>("/v1/subscriptionPromotionalOfferPrices", {
      data: {
        type: "subscriptionPromotionalOfferPrices",
        relationships: {
          subscriptionPromotionalOffer: { data: { type: "subscriptionPromotionalOffers", id: input.promotionalOfferId } },
          subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: pricePointId } },
          territory: { data: { type: "territories", id: input.territory } },
        },
      },
    });
    return { ok: true, priceId: res.data.id, promotionalOfferId: input.promotionalOfferId, territory: input.territory, pricePointId };
  },
});

export const deletePromotionalOfferTool = tool({
  name: "asc_delete_promotional_offer",
  description: "Delete a promotional offer by id. Find ids via asc_list_promotional_offers.",
  inputSchema: z.object({ promotionalOfferId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v1/subscriptionPromotionalOffers/${input.promotionalOfferId}`);
    return { ok: true, promotionalOfferId: input.promotionalOfferId };
  },
});
