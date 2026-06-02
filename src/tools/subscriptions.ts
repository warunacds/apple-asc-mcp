import { z } from "zod";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { tool } from "./registry.js";
import { runUpload } from "../upload.js";
import type {
  SubscriptionGroupAttrs, SubscriptionGroupLocAttrs, SubscriptionAttrs, SubscriptionLocAttrs,
  SubscriptionPricePointAttrs, ScreenshotAttrs,
} from "../types.js";

/**
 * Auto-renewable subscriptions. A subscriptionGroup holds one or more subscriptions; a customer can
 * have only one active subscription per group, and `groupLevel` ranks the upgrade/downgrade tiers.
 *
 * This mirrors the in-app-purchase tools (see src/tools/iap.ts) — same upsert idiom for
 * localizations, same base-territory price resolution, same review-screenshot reuse of runUpload.
 *
 * Like the rest of the server, none of this is validated against live Apple traffic yet. Spec
 * details inferred from sibling APIs are marked [VERIFY]; if a call 400s, attach the JSON:API error
 * body to an issue. Subscription child resources reference the parent as `subscription` (and group
 * children as `subscriptionGroup`) — simpler than the IAP v2 split, but still [VERIFY].
 */

const SUBSCRIPTION_PERIODS = ["ONE_WEEK", "ONE_MONTH", "TWO_MONTHS", "THREE_MONTHS", "SIX_MONTHS", "ONE_YEAR"] as const;
const OFFER_DURATIONS = ["THREE_DAYS", "ONE_WEEK", "TWO_WEEKS", "ONE_MONTH", "TWO_MONTHS", "THREE_MONTHS", "SIX_MONTHS", "ONE_YEAR"] as const;
const OFFER_MODES = ["FREE_TRIAL", "PAY_AS_YOU_GO", "PAY_UP_FRONT"] as const;

// ── Subscription groups ────────────────────────────────────────────────────

export const listSubscriptionGroupsTool = tool({
  name: "asc_list_subscription_groups",
  description:
    "List subscription groups for an app, with each group's subscriptions sideloaded (id, name, productId, period, state). " +
    "A customer can hold only one active subscription per group.",
  inputSchema: z.object({ appId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const res = await client.get(`/v1/apps/${input.appId}/subscriptionGroups`, {
      query: {
        limit: 200,
        include: "subscriptions",
        "fields[subscriptionGroups]": "referenceName,subscriptions",
        "fields[subscriptions]": "name,productId,subscriptionPeriod,state,groupLevel",
        "limit[subscriptions]": 50,
      },
    });
    return res;
  },
});

export const createSubscriptionGroupTool = tool({
  name: "asc_create_subscription_group",
  description:
    "Create a subscription group. referenceName is internal (not customer-facing) — set the customer-facing name " +
    "per locale with asc_set_subscription_group_localization. Subscriptions are then created inside the group with asc_create_subscription.",
  inputSchema: z.object({
    appId: z.string(),
    referenceName: z.string().max(64).describe("Internal group name shown in App Store Connect."),
  }).strict(),
  handler: async (input, { client }) => {
    const res = await client.post<{ data: { id: string; attributes: SubscriptionGroupAttrs } }>("/v1/subscriptionGroups", {
      data: {
        type: "subscriptionGroups",
        attributes: { referenceName: input.referenceName },
        relationships: { app: { data: { type: "apps", id: input.appId } } },
      },
    });
    return { id: res.data.id, ...res.data.attributes };
  },
});

export const setSubscriptionGroupLocalizationTool = tool({
  name: "asc_set_subscription_group_localization",
  description:
    "Upsert the customer-facing display name of a subscription group, per locale (and optional customAppName). " +
    "Creates the localization if missing, otherwise PATCHes it. name is required when first creating a locale.",
  inputSchema: z.object({
    subscriptionGroupId: z.string(),
    locale: z.string().describe("e.g. en-US, ja, de-DE"),
    name: z.string().optional().describe("Customer-facing group name. Required on first create for a locale."),
    customAppName: z.string().optional().describe("Optional app name override shown in the subscription management UI."),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<SubscriptionGroupLocAttrs>(
      `/v1/subscriptionGroups/${input.subscriptionGroupId}/subscriptionGroupLocalizations`,
      { limit: 200, "fields[subscriptionGroupLocalizations]": "locale" },
    );
    const match = existing.find((l) => l.attributes?.locale === input.locale);
    const attributes: Record<string, unknown> = {};
    if (input.name !== undefined) attributes.name = input.name;
    if (input.customAppName !== undefined) attributes.customAppName = input.customAppName;
    if (match) {
      const res = await client.patch<{ data: { id: string; attributes: SubscriptionGroupLocAttrs } }>(
        `/v1/subscriptionGroupLocalizations/${match.id}`,
        { data: { type: "subscriptionGroupLocalizations", id: match.id, attributes } },
      );
      return { id: match.id, action: "updated", attributes: res.data.attributes };
    }
    if (!input.name) throw new Error("name is required when creating a new subscriptionGroupLocalization.");
    const res = await client.post<{ data: { id: string; attributes: SubscriptionGroupLocAttrs } }>(
      "/v1/subscriptionGroupLocalizations",
      {
        data: {
          type: "subscriptionGroupLocalizations",
          attributes: { locale: input.locale, ...attributes },
          relationships: { subscriptionGroup: { data: { type: "subscriptionGroups", id: input.subscriptionGroupId } } },
        },
      },
    );
    return { id: res.data.id, action: "created", ...res.data.attributes };
  },
});

// ── Subscriptions ──────────────────────────────────────────────────────────

export const createSubscriptionTool = tool({
  name: "asc_create_subscription",
  description:
    "Create an auto-renewable subscription inside a group. Required: groupId, name (internal reference), productId " +
    "(StoreKit id, immutable), subscriptionPeriod. groupLevel ranks tiers within the group (1 = highest). " +
    "After creating, set a localization, a price, and availability before submitting.",
  inputSchema: z.object({
    groupId: z.string(),
    name: z.string().max(64).describe("Reference name shown in App Store Connect; not customer-facing."),
    productId: z.string().describe("StoreKit product identifier, e.g. com.example.app.pro.monthly. Immutable once set."),
    subscriptionPeriod: z.enum(SUBSCRIPTION_PERIODS),
    groupLevel: z.number().int().min(1).optional().describe("Rank within the group; 1 is the highest service level."),
    familySharable: z.boolean().optional(),
    reviewNote: z.string().max(4000).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {
      name: input.name,
      productId: input.productId,
      subscriptionPeriod: input.subscriptionPeriod,
    };
    if (input.groupLevel !== undefined) attributes.groupLevel = input.groupLevel;
    if (input.familySharable !== undefined) attributes.familySharable = input.familySharable;
    if (input.reviewNote !== undefined) attributes.reviewNote = input.reviewNote;
    const res = await client.post<{ data: { id: string; attributes: SubscriptionAttrs } }>("/v1/subscriptions", {
      data: {
        type: "subscriptions",
        attributes,
        relationships: { group: { data: { type: "subscriptionGroups", id: input.groupId } } },
      },
    });
    return { id: res.data.id, ...res.data.attributes };
  },
});

export const getSubscriptionTool = tool({
  name: "asc_get_subscription",
  description:
    "Read a single subscription with its localizations, prices, availability, and introductory offers. " +
    "Sub-resources are fetched best-effort and come back empty/null until set.",
  inputSchema: z.object({ subscriptionId: z.string() }).strict(),
  handler: async (input, { client }) => {
    const id = input.subscriptionId;
    const sub = await client.getOne<SubscriptionAttrs>(`/v1/subscriptions/${id}`, {
      "fields[subscriptions]": "name,productId,subscriptionPeriod,state,familySharable,reviewNote,groupLevel",
    });
    const localizations = await client
      .list<SubscriptionLocAttrs>(`/v1/subscriptions/${id}/subscriptionLocalizations`, {
        limit: 200,
        "fields[subscriptionLocalizations]": "locale,name,description,state",
      })
      .then((ls) => ls.map((l) => ({ id: l.id, ...l.attributes })))
      .catch(() => []);
    // [VERIFY] sub-resource paths. Best-effort so an unknown name degrades to null/[] rather than
    // failing the whole read — same defensive pattern as releaseStatusTool.
    const prices = await client.get(`/v1/subscriptions/${id}/prices`, { query: { include: "subscriptionPricePoint,territory", limit: 200 } }).catch(() => null);
    const availability = await client.get(`/v1/subscriptions/${id}/subscriptionAvailability`, { query: { include: "availableTerritories" } }).catch(() => null);
    const introductoryOffers = await client.get(`/v1/subscriptions/${id}/introductoryOffers`, { query: { limit: 50 } }).catch(() => null);
    return { id, ...sub.attributes, localizations, prices, availability, introductoryOffers };
  },
});

export const setSubscriptionLocalizationTool = tool({
  name: "asc_set_subscription_localization",
  description:
    "Upsert the customer-facing display name (≤30) and description (≤45) of a subscription, per locale. " +
    "Creates the localization if missing, otherwise PATCHes it. name is required when first creating a locale.",
  inputSchema: z.object({
    subscriptionId: z.string(),
    locale: z.string().describe("e.g. en-US, ja, de-DE"),
    name: z.string().max(30).optional().describe("Customer-facing display name. Required on first create for a locale."),
    description: z.string().max(45).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const existing = await client.list<SubscriptionLocAttrs>(
      `/v1/subscriptions/${input.subscriptionId}/subscriptionLocalizations`,
      { limit: 200, "fields[subscriptionLocalizations]": "locale" },
    );
    const match = existing.find((l) => l.attributes?.locale === input.locale);
    const attributes: Record<string, unknown> = {};
    if (input.name !== undefined) attributes.name = input.name;
    if (input.description !== undefined) attributes.description = input.description;
    if (match) {
      const res = await client.patch<{ data: { id: string; attributes: SubscriptionLocAttrs } }>(
        `/v1/subscriptionLocalizations/${match.id}`,
        { data: { type: "subscriptionLocalizations", id: match.id, attributes } },
      );
      return { id: match.id, action: "updated", attributes: res.data.attributes };
    }
    if (!input.name) throw new Error("name is required when creating a new subscriptionLocalization.");
    const res = await client.post<{ data: { id: string; attributes: SubscriptionLocAttrs } }>(
      "/v1/subscriptionLocalizations",
      {
        data: {
          type: "subscriptionLocalizations",
          attributes: { locale: input.locale, ...attributes },
          relationships: { subscription: { data: { type: "subscriptions", id: input.subscriptionId } } },
        },
      },
    );
    return { id: res.data.id, action: "created", ...res.data.attributes };
  },
});

// ── Pricing ──────────────────────────────────────────────────────────────────

export const listSubscriptionPricePointsTool = tool({
  name: "asc_list_subscription_price_points",
  description:
    "List the valid (server-defined) price points for a subscription in a territory. Apple sets fixed tiers per " +
    "billing period; you select one. Use the id with asc_set_subscription_price, or pass a customerPrice and let it resolve.",
  inputSchema: z.object({
    subscriptionId: z.string(),
    territory: z.string().default("USA").describe("Territory code, e.g. USA, GBR, JPN. See asc_list_territories."),
    limit: z.number().int().min(1).max(200).default(200).optional(),
  }).strict(),
  handler: async (input, { client }) => {
    const points = await client.list<SubscriptionPricePointAttrs>(`/v1/subscriptions/${input.subscriptionId}/pricePoints`, {
      "filter[territory]": input.territory,
      limit: input.limit ?? 200,
      "fields[subscriptionPricePoints]": "customerPrice,proceeds",
    });
    return points.map((p) => ({ id: p.id, ...p.attributes }));
  },
});

export const setSubscriptionPriceTool = tool({
  name: "asc_set_subscription_price",
  description:
    "Set the price of a subscription in a base territory; other territories auto-equalize from it. Provide customerPrice " +
    "(e.g. \"4.99\", resolved to a price point in the base territory) OR an explicit pricePointId from " +
    "asc_list_subscription_price_points. preserveCurrentPrice keeps existing subscribers on their current price.",
  inputSchema: z.object({
    subscriptionId: z.string(),
    baseTerritory: z.string().default("USA").describe("Territory whose price drives auto-equalization, e.g. USA."),
    customerPrice: z.string().optional().describe("Desired price in the base territory, e.g. \"4.99\". Provide this OR pricePointId."),
    pricePointId: z.string().optional().describe("Explicit price point id (from asc_list_subscription_price_points). Takes precedence over customerPrice."),
    preserveCurrentPrice: z.boolean().optional().describe("Keep existing subscribers on their current price (no automatic increase)."),
    startDate: z.string().optional().describe("ISO-8601 date the price takes effect; omit for immediate."),
  }).strict().refine((v) => v.customerPrice || v.pricePointId, { message: "Provide customerPrice or pricePointId." }),
  handler: async (input, { client }) => {
    let pricePointId = input.pricePointId;
    if (!pricePointId) {
      const points = await client.list<SubscriptionPricePointAttrs>(`/v1/subscriptions/${input.subscriptionId}/pricePoints`, {
        "filter[territory]": input.baseTerritory,
        limit: 200,
        "fields[subscriptionPricePoints]": "customerPrice,proceeds",
      });
      const match = points.find((p) => p.attributes?.customerPrice === input.customerPrice);
      if (!match) {
        const sample = points.slice(0, 12).map((p) => p.attributes?.customerPrice).filter(Boolean).join(", ");
        throw new Error(
          `No price point with customerPrice="${input.customerPrice}" in ${input.baseTerritory}. ` +
          `Available include: ${sample}… Use asc_list_subscription_price_points for the full list, then pass pricePointId.`,
        );
      }
      pricePointId = match.id;
    }

    // Unlike IAPs there is no price-schedule resource — a subscriptionPrice is created directly.
    // [VERIFY] A live POST returned 409 "error processing the pricing information" on
    // subscriptionPricePoint/id when a `territory` relationship was also sent — the price point already
    // encodes its territory, so we omit `territory`. Re-confirm against a live app.
    const attributes: Record<string, unknown> = {};
    if (input.preserveCurrentPrice !== undefined) attributes.preserveCurrentPrice = input.preserveCurrentPrice;
    if (input.startDate) attributes.startDate = input.startDate;
    const res = await client.post<{ data: { id: string } }>("/v1/subscriptionPrices", {
      data: {
        type: "subscriptionPrices",
        attributes,
        relationships: {
          subscription: { data: { type: "subscriptions", id: input.subscriptionId } },
          subscriptionPricePoint: { data: { type: "subscriptionPricePoints", id: pricePointId } },
        },
      },
    });
    return {
      ok: true,
      priceId: res.data.id,
      subscriptionId: input.subscriptionId,
      baseTerritory: input.baseTerritory,
      pricePointId,
      note: "Other territories auto-equalize from the base price point. Pass an explicit pricePointId per territory for manual control.",
    };
  },
});

// ── Availability ───────────────────────────────────────────────────────────

export const setSubscriptionAvailabilityTool = tool({
  name: "asc_set_subscription_availability",
  description:
    "Set the territories where a subscription is available. Pass territory codes (e.g. [\"USA\",\"GBR\"]) or " +
    "availableInAllTerritories=true. availableInNewTerritories controls whether Apple auto-adds future territories.",
  inputSchema: z.object({
    subscriptionId: z.string(),
    territories: z.array(z.string()).optional().describe("Territory codes. Required unless availableInAllTerritories is true."),
    availableInAllTerritories: z.boolean().optional(),
    availableInNewTerritories: z.boolean().default(true),
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
    const res = await client.post<{ data: { id: string } }>("/v1/subscriptionAvailabilities", {
      data: {
        type: "subscriptionAvailabilities",
        attributes: { availableInNewTerritories: input.availableInNewTerritories },
        relationships: {
          subscription: { data: { type: "subscriptions", id: input.subscriptionId } },
          availableTerritories: { data: (territoryIds ?? []).map((id) => ({ type: "territories", id })) },
        },
      },
    });
    return { ok: true, availabilityId: res.data.id, territories: territoryIds, availableInNewTerritories: input.availableInNewTerritories };
  },
});

// ── Introductory offers (free trials / pay-as-you-go / pay-up-front) ─────────

export const setSubscriptionIntroOfferTool = tool({
  name: "asc_set_subscription_intro_offer",
  description:
    "Create an introductory offer on a subscription. offerMode FREE_TRIAL needs no price; PAY_AS_YOU_GO and " +
    "PAY_UP_FRONT need a discounted pricePointId (from asc_list_subscription_price_points). Omit territory to apply " +
    "to all territories. duration + numberOfPeriods define the offer length (e.g. ONE_MONTH × 1).",
  inputSchema: z.object({
    subscriptionId: z.string(),
    offerMode: z.enum(OFFER_MODES),
    duration: z.enum(OFFER_DURATIONS).describe("Length of one offer period, e.g. ONE_WEEK, ONE_MONTH."),
    numberOfPeriods: z.number().int().min(1).default(1),
    territory: z.string().optional().describe("Territory code; omit to apply to all territories."),
    pricePointId: z.string().optional().describe("Required for PAY_AS_YOU_GO / PAY_UP_FRONT (the discounted price point). Omit for FREE_TRIAL."),
    startDate: z.string().optional().describe("ISO date the offer becomes active; omit for immediate."),
    endDate: z.string().optional().describe("ISO date the offer stops; omit for open-ended."),
  }).strict().refine(
    (v) => v.offerMode === "FREE_TRIAL" || !!v.pricePointId,
    { message: "pricePointId is required for paid introductory offers (PAY_AS_YOU_GO / PAY_UP_FRONT)." },
  ),
  handler: async (input, { client }) => {
    const attributes: Record<string, unknown> = {
      offerMode: input.offerMode,
      duration: input.duration,
      numberOfPeriods: input.numberOfPeriods,
    };
    if (input.startDate) attributes.startDate = input.startDate;
    if (input.endDate) attributes.endDate = input.endDate;
    const relationships: Record<string, unknown> = {
      subscription: { data: { type: "subscriptions", id: input.subscriptionId } },
    };
    // [VERIFY] omitting `territory` applies the offer to all territories; a price point is only set
    // for paid offer modes.
    if (input.territory) relationships.territory = { data: { type: "territories", id: input.territory } };
    if (input.pricePointId) relationships.subscriptionPricePoint = { data: { type: "subscriptionPricePoints", id: input.pricePointId } };
    const res = await client.post<{ data: { id: string; attributes?: Record<string, unknown> } }>("/v1/subscriptionIntroductoryOffers", {
      data: { type: "subscriptionIntroductoryOffers", attributes, relationships },
    });
    return { ok: true, offerId: res.data.id, ...res.data.attributes };
  },
});

// ── Review screenshot + submission ───────────────────────────────────────────

export const uploadSubscriptionReviewScreenshotTool = tool({
  name: "asc_upload_subscription_review_screenshot",
  description:
    "Upload the App Review screenshot for a subscription. Reservation → multipart PUT → checksum commit, the same " +
    "flow as app screenshots. PNG/JPG.",
  inputSchema: z.object({
    subscriptionId: z.string(),
    filePath: z.string().describe("Absolute path to a .png or .jpg file."),
  }).strict(),
  handler: async (input, { client }) => {
    const st = await stat(input.filePath);
    const fileName = basename(input.filePath);
    const reservation = await client.post<{ data: { id: string; attributes: ScreenshotAttrs } }>(
      "/v1/subscriptionAppStoreReviewScreenshots",
      {
        data: {
          type: "subscriptionAppStoreReviewScreenshots",
          attributes: { fileName, fileSize: st.size },
          relationships: { subscription: { data: { type: "subscriptions", id: input.subscriptionId } } },
        },
      },
    );
    const screenshotId = reservation.data.id;
    const ops = reservation.data.attributes?.uploadOperations ?? [];
    const checksum = await runUpload(input.filePath, ops);
    const committed = await client.patch<{ data: { id: string; attributes: ScreenshotAttrs } }>(
      `/v1/subscriptionAppStoreReviewScreenshots/${screenshotId}`,
      { data: { type: "subscriptionAppStoreReviewScreenshots", id: screenshotId, attributes: { uploaded: true, sourceFileChecksum: checksum } } },
    );
    return { id: screenshotId, fileName, fileSize: st.size, assetDeliveryState: committed.data.attributes?.assetDeliveryState };
  },
});

export const submitSubscriptionForReviewTool = tool({
  name: "asc_submit_subscription_for_review",
  description:
    "Submit a subscription group for App Review (POST /v1/subscriptionGroupSubmissions). Subscriptions submit at the " +
    "GROUP level — all pending changes in the group go together. Each subscription needs a localization, price, " +
    "availability, and usually a review screenshot first.",
  inputSchema: z.object({ subscriptionGroupId: z.string() }).strict(),
  handler: async (input, { client }) => {
    // [VERIFY] subscriptions submit via subscriptionGroupSubmissions at the group level (not per-subscription).
    const res = await client.post<{ data: { id: string; attributes?: { state?: string } } }>("/v1/subscriptionGroupSubmissions", {
      data: {
        type: "subscriptionGroupSubmissions",
        relationships: { subscriptionGroup: { data: { type: "subscriptionGroups", id: input.subscriptionGroupId } } },
      },
    });
    return { ok: true, submissionId: res.data.id, state: res.data.attributes?.state };
  },
});
