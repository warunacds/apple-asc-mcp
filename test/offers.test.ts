import test from "node:test";
import assert from "node:assert/strict";
import {
  listPromotionalOffersTool, createPromotionalOfferTool, addPromotionalOfferPriceTool, deletePromotionalOfferTool,
} from "../src/tools/offers.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

// Handler tests against a recording stub client (the AscClient is covered in client.test.ts).
// Focus: the promotional-offer payload (attributes + inline price), free-trial vs paid branching,
// price-point resolution, and the standalone add-price / delete paths.

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  post?: (path: string, body: unknown) => unknown;
  del?: (path: string) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new" } }; },
    async delete(path: string) { calls.push({ method: "DELETE", path }); return responses.del?.(path); },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_create_promotional_offer (paid) resolves the price and posts a self-consistent inline price", async () => {
  const { client, calls } = fakeClient({
    list: () => [{ id: "spp_099", attributes: { customerPrice: "0.99" } }, { id: "spp_199", attributes: { customerPrice: "1.99" } }],
    post: () => ({ data: { id: "promo1", attributes: { offerCode: "WINBACK" } } }),
  });
  const out = await createPromotionalOfferTool.handler(parse(createPromotionalOfferTool, {
    subscriptionId: "sub1", name: "Winback", offerCode: "WINBACK", offerMode: "PAY_AS_YOU_GO",
    duration: "ONE_MONTH", numberOfPeriods: 3, baseTerritory: "USA", customerPrice: "1.99",
  }), { client, config: cfg }) as { promotionalOfferId: string };
  assert.equal(out.promotionalOfferId, "promo1");
  const post = calls.find((c) => c.method === "POST")!;
  const body = post.body as any;
  assert.equal(post.path, "/v1/subscriptionPromotionalOffers");
  assert.equal(body.data.type, "subscriptionPromotionalOffers");
  assert.equal(body.data.attributes.offerCode, "WINBACK");
  assert.equal(body.data.attributes.offerMode, "PAY_AS_YOU_GO");
  assert.deepEqual(body.data.relationships.subscription.data, { type: "subscriptions", id: "sub1" });
  const lid = body.data.relationships.prices.data[0].id;
  const inc = body.included[0];
  assert.equal(inc.id, lid, "inline price id must match the prices reference");
  assert.equal(inc.relationships.subscriptionPricePoint.data.id, "spp_199");
  assert.equal(inc.relationships.territory.data.id, "USA");
});

test("asc_create_promotional_offer (FREE_TRIAL) carries no price and needs no lookup", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "promo2" } }) });
  await createPromotionalOfferTool.handler(parse(createPromotionalOfferTool, {
    subscriptionId: "sub1", name: "Free week", offerCode: "FREEWEEK", offerMode: "FREE_TRIAL", duration: "ONE_WEEK",
  }), { client, config: cfg });
  assert.equal(calls.some((c) => c.method === "LIST"), false, "free trial → no price-point lookup");
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.relationships.prices, undefined, "free trial → no prices relationship");
  assert.equal(body.included, undefined);
});

test("asc_create_promotional_offer accepts an explicit pricePointId and skips the lookup", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "promo3" } }) });
  await createPromotionalOfferTool.handler(parse(createPromotionalOfferTool, {
    subscriptionId: "sub1", name: "Promo", offerCode: "PROMO", offerMode: "PAY_UP_FRONT",
    duration: "THREE_MONTHS", pricePointId: "spp_explicit",
  }), { client, config: cfg });
  assert.equal(calls.some((c) => c.method === "LIST"), false);
  const inc = (calls.find((c) => c.method === "POST")!.body as any).included[0];
  assert.equal(inc.relationships.subscriptionPricePoint.data.id, "spp_explicit");
});

test("asc_create_promotional_offer errors when a paid offer's price has no matching tier", async () => {
  const { client } = fakeClient({ list: () => [{ id: "spp_099", attributes: { customerPrice: "0.99" } }] });
  await assert.rejects(
    () => createPromotionalOfferTool.handler(parse(createPromotionalOfferTool, {
      subscriptionId: "sub1", name: "X", offerCode: "X", offerMode: "PAY_AS_YOU_GO", duration: "ONE_MONTH", customerPrice: "3.33",
    }), { client, config: cfg }),
    /No price point/,
  );
});

test("asc_add_promotional_offer_price posts offer + price point + territory", async () => {
  const { client, calls } = fakeClient({
    list: () => [{ id: "spp_gbr_199", attributes: { customerPrice: "1.99" } }],
    post: () => ({ data: { id: "price_gbr" } }),
  });
  await addPromotionalOfferPriceTool.handler(parse(addPromotionalOfferPriceTool, {
    promotionalOfferId: "promo1", subscriptionId: "sub1", territory: "GBR", customerPrice: "1.99",
  }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "subscriptionPromotionalOfferPrices");
  assert.deepEqual(body.data.relationships.subscriptionPromotionalOffer.data, { type: "subscriptionPromotionalOffers", id: "promo1" });
  assert.deepEqual(body.data.relationships.subscriptionPricePoint.data, { type: "subscriptionPricePoints", id: "spp_gbr_199" });
  assert.deepEqual(body.data.relationships.territory.data, { type: "territories", id: "GBR" });
});

test("asc_delete_promotional_offer DELETEs the offer", async () => {
  const { client, calls } = fakeClient({});
  await deletePromotionalOfferTool.handler(parse(deletePromotionalOfferTool, { promotionalOfferId: "promo1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "DELETE")!.path, "/v1/subscriptionPromotionalOffers/promo1");
});

test("asc_list_promotional_offers reads the subscription's offers and flattens", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "promo1", attributes: { name: "Winback", offerCode: "WINBACK" } }] });
  const out = await listPromotionalOffersTool.handler(parse(listPromotionalOffersTool, { subscriptionId: "sub1" }), { client, config: cfg }) as Array<{ id: string; offerCode?: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/subscriptions/sub1/promotionalOffers");
  assert.equal(out[0]!.id, "promo1");
  assert.equal(out[0]!.offerCode, "WINBACK");
});
