import { z } from "zod";
import { tool } from "./registry.js";
import type { AppPricePointAttrs } from "../types.js";

/**
 * App pricing (the app's own price — free or paid), distinct from in-app-purchase pricing.
 *
 * Apple's model (v3): exactly one appPriceSchedule per app, referencing a baseTerritory and a list
 * of manualPrices. Prices are server-defined appPricePoints (fixed tiers) — you select one, you
 * don't type an amount. Territories you don't list auto-equalize from the base. A free app is just
 * the $0 price point.
 *
 * Not yet validated against live Apple traffic; spec inferred from research/api-reference.md §12 and
 * sibling APIs. If a call 400s, the JSON:API error body pins down the exact shape.
 */

export const listAppPricePointsTool = tool({
  name: "asc_list_app_price_points",
  description:
    "List the valid (server-defined) price points for an app in a territory. Apple sets fixed tiers (0.99, 1.99, …, " +
    "and 0.00 for free); you select one. Use the id with asc_set_app_price, or pass a customerPrice and let it resolve.",
  inputSchema: z.object({
    appId: z.string(),
    territory: z.string().default("USA").describe("Territory code, e.g. USA, GBR, JPN, DEU."),
    limit: z.number().int().min(1).max(200).default(200).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const points = await client.list<AppPricePointAttrs>(`/v1/apps/${input.appId}/appPricePoints`, {
      "filter[territory]": input.territory,
      limit: input.limit ?? 200,
      "fields[appPricePoints]": "customerPrice,proceeds",
    });
    return points.map((p) => ({ id: p.id, ...p.attributes }));
  },
});

export const getAppPriceScheduleTool = tool({
  name: "asc_get_app_price_schedule",
  description: "Read the app's current price schedule (base territory + manual prices). Returns null-ish if no price is set yet.",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    return await client.get(`/v1/apps/${input.appId}/appPriceSchedule`, {
      query: { include: "baseTerritory,manualPrices" },
    });
  },
});

export const setAppPriceTool = tool({
  name: "asc_set_app_price",
  description:
    "Set the app's price. Pick a price point in a base territory; other territories auto-equalize from it. " +
    "Pass free=true for a free app, or customerPrice (e.g. \"4.99\", resolved to a tier in the base territory), or an " +
    "explicit pricePointId from asc_list_app_price_points. This replaces the app's existing price schedule.",
  inputSchema: z.object({
    appId: z.string(),
    baseTerritory: z.string().default("USA").describe("Territory whose price drives auto-equalization, e.g. USA."),
    free: z.boolean().optional().describe("Shortcut for the $0 price tier."),
    customerPrice: z.string().optional().describe("Desired price in the base territory, e.g. \"4.99\". Provide free, customerPrice, or pricePointId."),
    pricePointId: z.string().optional().describe("Explicit price point id (from asc_list_app_price_points). Takes precedence."),
    startDate: z.string().optional().describe("ISO-8601 date the price takes effect; omit for immediate."),
  }).strict().refine(
    (v) => v.free || v.customerPrice || v.pricePointId,
    { message: "Provide free=true, customerPrice, or pricePointId." },
  ),
  handler: async (input, { client }) => {
    let pricePointId = input.pricePointId;
    if (!pricePointId) {
      const points = await client.list<AppPricePointAttrs>(`/v1/apps/${input.appId}/appPricePoints`, {
        "filter[territory]": input.baseTerritory,
        limit: 200,
        "fields[appPricePoints]": "customerPrice,proceeds",
      });
      const wanted = input.free ? ["0.00", "0"] : [input.customerPrice];
      const match = points.find((p) => wanted.includes(p.attributes?.customerPrice ?? ""));
      if (!match) {
        const sample = points.slice(0, 12).map((p) => p.attributes?.customerPrice).filter(Boolean).join(", ");
        throw new Error(
          input.free
            ? `No $0 price point found in ${input.baseTerritory} (sampled: ${sample}…). Use asc_list_app_price_points and pass pricePointId.`
            : `No price point with customerPrice="${input.customerPrice}" in ${input.baseTerritory}. Available include: ${sample}… Use asc_list_app_price_points, then pass pricePointId.`,
        );
      }
      pricePointId = match.id;
    }

    // App Store Connect creates the manual price inline via a placeholder id referenced from both
    // relationships.manualPrices and included. Unlisted territories auto-equalize from the base.
    const priceLid = "${new-app-price-1}";
    const res = await client.post<{ data: { id: string } }>("/v1/appPriceSchedules", {
      data: {
        type: "appPriceSchedules",
        relationships: {
          app: { data: { type: "apps", id: input.appId } },
          baseTerritory: { data: { type: "territories", id: input.baseTerritory } },
          manualPrices: { data: [{ type: "appPrices", id: priceLid }] },
        },
      },
      included: [
        {
          type: "appPrices",
          id: priceLid,
          attributes: input.startDate ? { startDate: input.startDate } : {},
          relationships: {
            appPricePoint: { data: { type: "appPricePoints", id: pricePointId } },
            territory: { data: { type: "territories", id: input.baseTerritory } },
          },
        },
      ],
    });
    return {
      ok: true,
      scheduleId: res.data.id,
      appId: input.appId,
      baseTerritory: input.baseTerritory,
      pricePointId,
      free: !!input.free,
      note: "Other territories auto-equalize from the base price point. Pass an explicit pricePointId per territory for manual control.",
    };
  },
});
