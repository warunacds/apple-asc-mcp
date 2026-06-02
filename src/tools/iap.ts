import { z } from "zod";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { tool } from "./registry.js";
import { runUpload } from "../upload.js";
import type { InAppPurchaseAttrs, IapLocalizationAttrs, IapPricePointAttrs, ScreenshotAttrs } from "../types.js";

/**
 * In-App Purchases (v2): Consumable, Non-Consumable, Non-Renewing Subscription.
 * Auto-renewable subscriptions are a separate resource family (phase 2).
 *
 * The whole release path of this server is not yet validated against live Apple traffic; these
 * IAP tools inherit that status. Spec details inferred from sibling APIs are marked [VERIFY].
 * If a call 400s, attach the JSON:API error body to an issue — that's the fastest way to confirm.
 *
 * A recurring [VERIFY] across this file: which relationship key names a v2 IAP. Apple's v2 IAP
 * resources reference the purchase as `inAppPurchaseV2` on child metadata (localizations, review
 * screenshot, submission) but as `inAppPurchase` on the price schedule / availability. We follow
 * that split below.
 */

const IAP_TYPES = ["CONSUMABLE", "NON_CONSUMABLE", "NON_RENEWING_SUBSCRIPTION"] as const;

export const listInAppPurchasesTool = tool({
  name: "asc_list_in_app_purchases",
  description:
    "List in-app purchases for an app (Consumable / Non-Consumable / Non-Renewing Subscription). " +
    "Filter by inAppPurchaseType or state. Returns id, name (internal reference), productId, type, state.",
  inputSchema: z.object({
    appId: z.string(),
    inAppPurchaseType: z.enum(IAP_TYPES).optional(),
    state: z.string().optional().describe("e.g. MISSING_METADATA, READY_TO_SUBMIT, WAITING_FOR_REVIEW, APPROVED, DEVELOPER_ACTION_NEEDED."),
    limit: z.number().int().min(1).max(200).default(50).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const q: Record<string, string | number | undefined> = {
      limit: input.limit ?? 50,
      "fields[inAppPurchases]": "name,productId,inAppPurchaseType,state,reviewNote,familySharable",
    };
    if (input.inAppPurchaseType) q["filter[inAppPurchaseType]"] = input.inAppPurchaseType;
    if (input.state) q["filter[state]"] = input.state;
    const iaps = await client.list<InAppPurchaseAttrs>(`/v1/apps/${input.appId}/inAppPurchasesV2`, q);
    return iaps.map((i) => ({ id: i.id, ...i.attributes }));
  },
});

export const getInAppPurchaseTool = tool({
  name: "asc_get_in_app_purchase",
  description:
    "Read a single in-app purchase with its localizations, price schedule, and availability. " +
    "Use asc_list_in_app_purchases to find the id. Price schedule / availability are fetched best-effort " +
    "and come back null until they've been set.",
  inputSchema: z.object({ inAppPurchaseId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const id = input.inAppPurchaseId;
    const iap = await client.getOne<InAppPurchaseAttrs>(`/v2/inAppPurchases/${id}`, {
      "fields[inAppPurchases]": "name,productId,inAppPurchaseType,state,reviewNote,familySharable",
    });
    const localizations = await client
      .list<IapLocalizationAttrs>(`/v2/inAppPurchases/${id}/inAppPurchaseLocalizations`, {
        limit: 200,
        "fields[inAppPurchaseLocalizations]": "locale,name,description,state",
      })
      .then((ls) => ls.map((l) => ({ id: l.id, ...l.attributes })))
      .catch(() => []);
    // [VERIFY] sub-resource relationship paths. Fetched best-effort so an unknown name degrades to
    // null rather than failing the whole read — same defensive pattern as releaseStatusTool.
    const priceSchedule = await client
      .get(`/v2/inAppPurchases/${id}/iapPriceSchedule`, { query: { include: "manualPrices,baseTerritory" } })
      .catch(() => null);
    const availability = await client
      .get(`/v2/inAppPurchases/${id}/inAppPurchaseAvailability`, { query: { include: "availableTerritories" } })
      .catch(() => null);
    return { id, ...iap.attributes, localizations, priceSchedule, availability };
  },
});

export const createInAppPurchaseTool = tool({
  name: "asc_create_in_app_purchase",
  description:
    "Create an in-app purchase product. Required: appId, name (internal reference name), productId (StoreKit " +
    "product id, unique per app, immutable once set), inAppPurchaseType. After creating, set a localization " +
    "(asc_set_iap_localization), a price (asc_set_iap_price), and availability (asc_set_iap_availability) before submitting.",
  inputSchema: z.object({
    appId: z.string(),
    name: z.string().max(64).describe("Reference name shown in App Store Connect; not customer-facing."),
    productId: z.string().describe("StoreKit product identifier, e.g. com.example.app.pro_upgrade. Immutable once set."),
    inAppPurchaseType: z.enum(IAP_TYPES),
    familySharable: z.boolean().optional(),
    reviewNote: z.string().max(4000).optional().describe("Note to App Review explaining the product."),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {
      name: input.name,
      productId: input.productId,
      inAppPurchaseType: input.inAppPurchaseType,
    };
    if (input.familySharable !== undefined) attributes.familySharable = input.familySharable;
    if (input.reviewNote !== undefined) attributes.reviewNote = input.reviewNote;
    const res = await client.post<{ data: { id: string; attributes: InAppPurchaseAttrs } }>("/v2/inAppPurchases", {
      data: {
        type: "inAppPurchases",
        attributes,
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    });
    return { id: res.data.id, ...res.data.attributes };
  },
});

export const setIapLocalizationTool = tool({
  name: "asc_set_iap_localization",
  description:
    "Upsert the customer-facing display name (≤30 chars) and description (≤45 chars) of an in-app purchase, per " +
    "locale. Creates the localization if missing, otherwise PATCHes it. name is required when first creating a locale.",
  inputSchema: z.object({
    inAppPurchaseId: z.string(),
    locale: z.string().describe("e.g. en-US, ja, de-DE"),
    name: z.string().max(30).optional().describe("Customer-facing display name. Required on first create for a locale."),
    description: z.string().max(45).optional().describe("Customer-facing description."),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<IapLocalizationAttrs>(
      `/v2/inAppPurchases/${input.inAppPurchaseId}/inAppPurchaseLocalizations`,
      { limit: 200, "fields[inAppPurchaseLocalizations]": "locale" },
    );
    const match = existing.find((l) => l.attributes?.locale === input.locale);
    const attributes: Record<string, unknown> = {};
    if (input.name !== undefined) attributes.name = input.name;
    if (input.description !== undefined) attributes.description = input.description;
    if (match) {
      const res = await client.patch<{ data: { id: string; attributes: IapLocalizationAttrs } }>(
        `/v1/inAppPurchaseLocalizations/${match.id}`,
        { data: { type: "inAppPurchaseLocalizations", id: match.id, attributes } },
      );
      return { id: match.id, action: "updated", attributes: res.data.attributes };
    }
    if (!input.name) throw new Error("name is required when creating a new inAppPurchaseLocalization.");
    const res = await client.post<{ data: { id: string; attributes: IapLocalizationAttrs } }>(
      "/v1/inAppPurchaseLocalizations",
      {
        data: {
          type: "inAppPurchaseLocalizations",
          attributes: { locale: input.locale, ...attributes },
          // [VERIFY] localizations reference the purchase as `inAppPurchaseV2`.
          relationships: { inAppPurchaseV2: { data: { type: "inAppPurchases", id: input.inAppPurchaseId } } },
        },
      },
    );
    return { id: res.data.id, action: "created", ...res.data.attributes };
  },
});

export const listIapPricePointsTool = tool({
  name: "asc_list_iap_price_points",
  description:
    "List the valid (server-defined) price points for an in-app purchase in a territory. Apple sets fixed tiers " +
    "(e.g. 0.99, 1.99); you select one, you don't enter a raw amount. Use the returned id with asc_set_iap_price, " +
    "or just pass customerPrice to asc_set_iap_price and let it resolve.",
  inputSchema: z.object({
    inAppPurchaseId: z.string(),
    territory: z.string().default("USA").describe("Territory code, e.g. USA, GBR, JPN. See asc_list_territories."),
    limit: z.number().int().min(1).max(200).default(200).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const points = await client.list<IapPricePointAttrs>(`/v2/inAppPurchases/${input.inAppPurchaseId}/pricePoints`, {
      "filter[territory]": input.territory,
      limit: input.limit ?? 200,
      "fields[inAppPurchasePricePoints]": "customerPrice,proceeds",
    });
    return points.map((p) => ({ id: p.id, ...p.attributes }));
  },
});

export const setIapPriceTool = tool({
  name: "asc_set_iap_price",
  description:
    "Set the price of an in-app purchase. Pick a price point in a base territory; Apple auto-equalizes the other " +
    "territories from it. Provide customerPrice (e.g. \"0.99\", resolved to a price point in the base territory) OR " +
    "an explicit pricePointId from asc_list_iap_price_points. This replaces any existing price schedule.",
  inputSchema: z.object({
    inAppPurchaseId: z.string(),
    baseTerritory: z.string().default("USA").describe("Territory whose price drives auto-equalization, e.g. USA."),
    customerPrice: z.string().optional().describe("Desired price in the base territory, e.g. \"0.99\". Provide this OR pricePointId."),
    pricePointId: z.string().optional().describe("Explicit price point id (from asc_list_iap_price_points). Takes precedence over customerPrice."),
    startDate: z.string().optional().describe("ISO-8601 date the price takes effect; omit for immediate."),
  }).strict().refine((v) => v.customerPrice || v.pricePointId, { message: "Provide customerPrice or pricePointId." }),
  handler: async (input, { client }) => {
    let pricePointId = input.pricePointId;
    if (!pricePointId) {
      const points = await client.list<IapPricePointAttrs>(`/v2/inAppPurchases/${input.inAppPurchaseId}/pricePoints`, {
        "filter[territory]": input.baseTerritory,
        limit: 200,
        "fields[inAppPurchasePricePoints]": "customerPrice,proceeds",
      });
      const match = points.find((p) => p.attributes?.customerPrice === input.customerPrice);
      if (!match) {
        const sample = points.slice(0, 12).map((p) => p.attributes?.customerPrice).filter(Boolean).join(", ");
        throw new Error(
          `No price point with customerPrice="${input.customerPrice}" in ${input.baseTerritory}. ` +
          `Available include: ${sample}… Use asc_list_iap_price_points for the full list, then pass pricePointId.`,
        );
      }
      pricePointId = match.id;
    }

    // App Store Connect creates the manual price inline via a placeholder id referenced from both
    // `relationships.manualPrices` and `included`. Territories not listed auto-equalize from the base.
    const priceLid = "${new-price-1}";
    const res = await client.post<{ data: { id: string } }>("/v1/inAppPurchasePriceSchedules", {
      data: {
        type: "inAppPurchasePriceSchedules",
        relationships: {
          // [VERIFY] the price schedule references the purchase as `inAppPurchase` (not `inAppPurchaseV2`).
          inAppPurchase: { data: { type: "inAppPurchases", id: input.inAppPurchaseId } },
          baseTerritory: { data: { type: "territories", id: input.baseTerritory } },
          manualPrices: { data: [{ type: "inAppPurchasePrices", id: priceLid }] },
        },
      },
      included: [
        {
          type: "inAppPurchasePrices",
          id: priceLid,
          attributes: input.startDate ? { startDate: input.startDate } : {},
          relationships: {
            inAppPurchasePricePoint: { data: { type: "inAppPurchasePricePoints", id: pricePointId } },
            territory: { data: { type: "territories", id: input.baseTerritory } },
          },
        },
      ],
    });
    return {
      ok: true,
      scheduleId: res.data.id,
      inAppPurchaseId: input.inAppPurchaseId,
      baseTerritory: input.baseTerritory,
      pricePointId,
      note: "Other territories auto-equalize from the base price point. Pass an explicit pricePointId per territory for manual control.",
    };
  },
});

export const setIapAvailabilityTool = tool({
  name: "asc_set_iap_availability",
  description:
    "Set the territories where an in-app purchase is available. Pass territory codes (e.g. [\"USA\",\"GBR\"]) or " +
    "availableInAllTerritories=true. availableInNewTerritories controls whether Apple auto-adds future territories.",
  inputSchema: z.object({
    inAppPurchaseId: z.string(),
    territories: z.array(z.string()).optional().describe("Territory codes. Required unless availableInAllTerritories is true."),
    availableInAllTerritories: z.boolean().optional().describe("Make available everywhere; expands to the full territory list."),
    availableInNewTerritories: z.boolean().default(true).describe("Auto-add territories Apple introduces later."),
  }).strict().refine(
    (v) => v.availableInAllTerritories || (v.territories?.length ?? 0) > 0,
    { message: "Provide territories[] or availableInAllTerritories=true." },
  ),
  handler: async (input, { client }) => {
    let territoryIds = input.territories;
    if (input.availableInAllTerritories && !territoryIds) {
      const all = await client.list("/v1/territories", { limit: 200 });
      territoryIds = all.map((t) => t.id);
    }
    const res = await client.post<{ data: { id: string } }>("/v1/inAppPurchaseAvailabilities", {
      data: {
        type: "inAppPurchaseAvailabilities",
        attributes: { availableInNewTerritories: input.availableInNewTerritories },
        relationships: {
          // [VERIFY] availability references the purchase as `inAppPurchase`.
          inAppPurchase: { data: { type: "inAppPurchases", id: input.inAppPurchaseId } },
          availableTerritories: { data: (territoryIds ?? []).map((id) => ({ type: "territories", id })) },
        },
      },
    });
    return { ok: true, availabilityId: res.data.id, territories: territoryIds, availableInNewTerritories: input.availableInNewTerritories };
  },
});

export const uploadIapReviewScreenshotTool = tool({
  name: "asc_upload_iap_review_screenshot",
  description:
    "Upload the App Review screenshot for an in-app purchase (required before submission for most IAPs). " +
    "Reservation → multipart PUT → checksum commit, the same flow as app screenshots. PNG/JPG.",
  inputSchema: z.object({
    inAppPurchaseId: z.string(),
    filePath: z.string().describe("Absolute path to a .png or .jpg file."),
  }).strict(),
  handler: async (input, { client }) => {
    const st = await stat(input.filePath);
    const fileName = basename(input.filePath);
    const reservation = await client.post<{ data: { id: string; attributes: ScreenshotAttrs } }>(
      "/v1/inAppPurchaseAppStoreReviewScreenshots",
      {
        data: {
          type: "inAppPurchaseAppStoreReviewScreenshots",
          attributes: { fileName, fileSize: st.size },
          // [VERIFY] review screenshot references the purchase as `inAppPurchaseV2`.
          relationships: { inAppPurchaseV2: { data: { type: "inAppPurchases", id: input.inAppPurchaseId } } },
        },
      },
    );
    const screenshotId = reservation.data.id;
    const ops = reservation.data.attributes?.uploadOperations ?? [];
    const checksum = await runUpload(input.filePath, ops);
    const committed = await client.patch<{ data: { id: string; attributes: ScreenshotAttrs } }>(
      `/v1/inAppPurchaseAppStoreReviewScreenshots/${screenshotId}`,
      { data: { type: "inAppPurchaseAppStoreReviewScreenshots", id: screenshotId, attributes: { uploaded: true, sourceFileChecksum: checksum } } },
    );
    return {
      id: screenshotId,
      fileName,
      fileSize: st.size,
      assetDeliveryState: committed.data.attributes?.assetDeliveryState,
    };
  },
});

export const deleteInAppPurchaseTool = tool({
  name: "asc_delete_in_app_purchase",
  description:
    "Permanently delete an in-app purchase (DELETE /v2/inAppPurchases/{id}). Use asc_list_in_app_purchases to find " +
    "the id. Only works while the product is still editable — Apple rejects deletes once it has been approved or is " +
    "in review. This cannot be undone.",
  inputSchema: z.object({ inAppPurchaseId: z.string() }).strict(),
  handler: async (input, { client }) => {
    await client.delete(`/v2/inAppPurchases/${input.inAppPurchaseId}`);
    return { ok: true, deleted: input.inAppPurchaseId };
  },
});

export const submitIapForReviewTool = tool({
  name: "asc_submit_iap_for_review",
  description:
    "Submit an in-app purchase for App Review on its own (POST /v1/inAppPurchaseSubmissions). The IAP must have a " +
    "localization, a price, availability, and usually a review screenshot. To bundle the IAP into an app version's " +
    "submission instead, use asc_submit_for_review with additionalItems=[{type:\"inAppPurchaseV2\", id}].",
  inputSchema: z.object({ inAppPurchaseId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string; attributes?: { state?: string } } }>("/v1/inAppPurchaseSubmissions", {
      data: {
        type: "inAppPurchaseSubmissions",
        // [VERIFY] submission references the purchase as `inAppPurchaseV2`.
        relationships: { inAppPurchaseV2: { data: { type: "inAppPurchases", id: input.inAppPurchaseId } } },
      },
    });
    return { ok: true, submissionId: res.data.id, state: res.data.attributes?.state };
  },
});
