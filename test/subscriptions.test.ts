import test from "node:test";
import assert from "node:assert/strict";
import {
  createSubscriptionGroupTool, setSubscriptionGroupLocalizationTool, createSubscriptionTool,
  setSubscriptionPriceTool, setSubscriptionIntroOfferTool,
} from "../src/tools/subscriptions.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

// Exercise the subscription handlers against a recording stub client (the AscClient is covered in
// client.test.ts). Assertions focus on the exact JSON:API payloads and the handler branching that
// would be expensive to discover only against the live API.

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new", attributes: {} } }; },
    async patch(path: string, body: unknown) { calls.push({ method: "PATCH", path, body }); return responses.patch?.(path, body) ?? { data: { id: "patched", attributes: {} } }; },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_create_subscription_group posts referenceName + app relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "grp1", attributes: { referenceName: "Pro" } } }) });
  const out = await createSubscriptionGroupTool.handler(
    parse(createSubscriptionGroupTool, { appId: "app1", referenceName: "Pro" }),
    { client, config: cfg },
  ) as { id: string };
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "subscriptionGroups");
  assert.equal(body.data.attributes.referenceName, "Pro");
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
  assert.equal(out.id, "grp1");
});

test("asc_create_subscription posts period + group relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "sub1", attributes: { name: "Monthly", subscriptionPeriod: "ONE_MONTH" } } }) });
  await createSubscriptionTool.handler(
    parse(createSubscriptionTool, { groupId: "grp1", name: "Monthly", productId: "com.x.pro.monthly", subscriptionPeriod: "ONE_MONTH", groupLevel: 1 }),
    { client, config: cfg },
  );
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "subscriptions");
  assert.equal(body.data.attributes.subscriptionPeriod, "ONE_MONTH");
  assert.equal(body.data.attributes.groupLevel, 1);
  assert.deepEqual(body.data.relationships.group.data, { type: "subscriptionGroups", id: "grp1" });
});

test("asc_set_subscription_group_localization creates then updates", async () => {
  let existing: unknown[] = [];
  const { client, calls } = fakeClient({
    list: () => existing,
    post: () => ({ data: { id: "loc1", attributes: { locale: "en-US", name: "Pro" } } }),
    patch: () => ({ data: { id: "loc1", attributes: { locale: "en-US", name: "Pro+" } } }),
  });
  const created = await setSubscriptionGroupLocalizationTool.handler(
    parse(setSubscriptionGroupLocalizationTool, { subscriptionGroupId: "grp1", locale: "en-US", name: "Pro" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(created.action, "created");
  const cbody = calls.find((c) => c.method === "POST")!.body as any;
  assert.deepEqual(cbody.data.relationships.subscriptionGroup.data, { type: "subscriptionGroups", id: "grp1" });

  existing = [{ id: "loc1", attributes: { locale: "en-US" } }];
  const updated = await setSubscriptionGroupLocalizationTool.handler(
    parse(setSubscriptionGroupLocalizationTool, { subscriptionGroupId: "grp1", locale: "en-US", name: "Pro+" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(updated.action, "updated");
  assert.equal(calls.find((c) => c.method === "PATCH")!.path, "/v1/subscriptionGroupLocalizations/loc1");
});

test("asc_set_subscription_price resolves customerPrice and posts subscription/pricePoint/territory", async () => {
  const { client, calls } = fakeClient({
    list: (path) => path.includes("/pricePoints")
      ? [{ id: "spp_low", attributes: { customerPrice: "0.99" } }, { id: "spp_hi", attributes: { customerPrice: "9.99" } }]
      : [],
    post: () => ({ data: { id: "price1" } }),
  });
  const out = await setSubscriptionPriceTool.handler(
    parse(setSubscriptionPriceTool, { subscriptionId: "sub1", baseTerritory: "USA", customerPrice: "9.99", preserveCurrentPrice: true }),
    { client, config: cfg },
  ) as { pricePointId: string };
  assert.equal(out.pricePointId, "spp_hi");
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "subscriptionPrices");
  assert.equal(body.data.attributes.preserveCurrentPrice, true);
  assert.deepEqual(body.data.relationships.subscriptionPricePoint.data, { type: "subscriptionPricePoints", id: "spp_hi" });
  assert.deepEqual(body.data.relationships.territory.data, { type: "territories", id: "USA" });
});

test("asc_set_subscription_intro_offer: FREE_TRIAL omits the price point", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "offer1", attributes: { offerMode: "FREE_TRIAL" } } }) });
  await setSubscriptionIntroOfferTool.handler(
    parse(setSubscriptionIntroOfferTool, { subscriptionId: "sub1", offerMode: "FREE_TRIAL", duration: "ONE_MONTH", numberOfPeriods: 1 }),
    { client, config: cfg },
  );
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "subscriptionIntroductoryOffers");
  assert.equal(body.data.attributes.offerMode, "FREE_TRIAL");
  assert.equal(body.data.relationships.subscriptionPricePoint, undefined, "free trial must not carry a price point");
  assert.equal(body.data.relationships.territory, undefined, "no territory → all territories");
});

test("asc_set_subscription_intro_offer: paid offer requires a price point (schema guard)", () => {
  // The guard is a zod .refine(), so it rejects at parse time — before the handler runs.
  assert.throws(
    () => parse(setSubscriptionIntroOfferTool, { subscriptionId: "sub1", offerMode: "PAY_AS_YOU_GO", duration: "THREE_MONTHS", numberOfPeriods: 3 }),
    /pricePointId is required/,
  );
});

test("asc_set_subscription_intro_offer: paid offer attaches the price point + territory", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "offer2", attributes: { offerMode: "PAY_UP_FRONT" } } }) });
  await setSubscriptionIntroOfferTool.handler(
    parse(setSubscriptionIntroOfferTool, { subscriptionId: "sub1", offerMode: "PAY_UP_FRONT", duration: "THREE_MONTHS", numberOfPeriods: 1, pricePointId: "spp_disc", territory: "USA" }),
    { client, config: cfg },
  );
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.deepEqual(body.data.relationships.subscriptionPricePoint.data, { type: "subscriptionPricePoints", id: "spp_disc" });
  assert.deepEqual(body.data.relationships.territory.data, { type: "territories", id: "USA" });
});
