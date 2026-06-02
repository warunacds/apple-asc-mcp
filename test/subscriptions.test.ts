import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  listSubscriptionGroupsTool, createSubscriptionGroupTool, setSubscriptionGroupLocalizationTool,
  createSubscriptionTool, getSubscriptionTool, setSubscriptionLocalizationTool,
  listSubscriptionPricePointsTool, setSubscriptionPriceTool, setSubscriptionAvailabilityTool,
  setSubscriptionIntroOfferTool, uploadSubscriptionReviewScreenshotTool, submitSubscriptionForReviewTool,
} from "../src/tools/subscriptions.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

// Exercise the subscription handlers against a recording stub client (the AscClient is covered in
// client.test.ts). Assertions focus on the exact JSON:API payloads and the handler branching that
// would be expensive to discover only against the live API.

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  get?: (path: string) => unknown;
  getOne?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async get(path: string) { calls.push({ method: "GET", path }); return responses.get?.(path); },
    async getOne(path: string) { calls.push({ method: "GETONE", path }); return responses.getOne?.(path) ?? { id: "x", attributes: {} }; },
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

test("asc_set_subscription_price resolves customerPrice and posts subscription/pricePoint (no territory)", async () => {
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
  assert.equal(body.data.relationships.territory, undefined, "subscription prices omit territory — the price point encodes it");
});

test("asc_set_subscription_price accepts an explicit pricePointId and skips the lookup", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "price2" } }) });
  const out = await setSubscriptionPriceTool.handler(
    parse(setSubscriptionPriceTool, { subscriptionId: "sub1", baseTerritory: "USA", pricePointId: "spp_explicit" }),
    { client, config: cfg },
  ) as { pricePointId: string };
  assert.equal(out.pricePointId, "spp_explicit");
  assert.equal(calls.some((c) => c.method === "LIST"), false, "no price-point lookup when an id is given");
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.deepEqual(body.data.relationships.subscriptionPricePoint.data, { type: "subscriptionPricePoints", id: "spp_explicit" });
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

test("asc_list_subscription_groups reads the app's groups", async () => {
  const { client, calls } = fakeClient({ get: () => ({ data: [{ id: "grp1", attributes: { referenceName: "Pro" } }], included: [] }) });
  const out = await listSubscriptionGroupsTool.handler(parse(listSubscriptionGroupsTool, { appId: "app1" }), { client, config: cfg }) as any;
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/apps/app1/subscriptionGroups");
  assert.equal(out.data[0].id, "grp1");
});

test("asc_get_subscription assembles best-effort sub-resources", async () => {
  const { client, calls } = fakeClient({
    getOne: () => ({ id: "sub1", attributes: { name: "Monthly", productId: "com.x.m", subscriptionPeriod: "ONE_MONTH" } }),
    list: () => [{ id: "loc1", attributes: { locale: "en-US", name: "Monthly" } }],
    get: (path) => ({ data: { id: "x", path } }),
  });
  const out = await getSubscriptionTool.handler(parse(getSubscriptionTool, { subscriptionId: "sub1" }), { client, config: cfg }) as any;
  assert.equal(calls.find((c) => c.method === "GETONE")!.path, "/v1/subscriptions/sub1");
  assert.equal(out.id, "sub1");
  assert.equal(out.productId, "com.x.m");
  assert.equal(out.localizations[0].locale, "en-US");
  assert.ok(out.prices);
  assert.ok(out.availability);
  assert.ok(out.introductoryOffers);
});

test("asc_get_subscription degrades failing sub-resources", async () => {
  const { client } = fakeClient({
    getOne: () => ({ id: "sub1", attributes: {} }),
    list: () => { throw new Error("boom"); },
    get: () => { throw new Error("boom"); },
  });
  const out = await getSubscriptionTool.handler(parse(getSubscriptionTool, { subscriptionId: "sub1" }), { client, config: cfg }) as any;
  assert.deepEqual(out.localizations, []);
  assert.equal(out.prices, null);
  assert.equal(out.introductoryOffers, null);
});

test("asc_set_subscription_localization creates then updates", async () => {
  let existing: unknown[] = [];
  const { client, calls } = fakeClient({
    list: () => existing,
    post: () => ({ data: { id: "loc1", attributes: { locale: "en-US", name: "Monthly" } } }),
    patch: () => ({ data: { id: "loc1", attributes: { locale: "en-US", name: "Monthly+" } } }),
  });
  const created = await setSubscriptionLocalizationTool.handler(
    parse(setSubscriptionLocalizationTool, { subscriptionId: "sub1", locale: "en-US", name: "Monthly", description: "Billed monthly" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(created.action, "created");
  const cbody = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(cbody.data.type, "subscriptionLocalizations");
  assert.deepEqual(cbody.data.relationships.subscription.data, { type: "subscriptions", id: "sub1" });

  existing = [{ id: "loc1", attributes: { locale: "en-US" } }];
  const updated = await setSubscriptionLocalizationTool.handler(
    parse(setSubscriptionLocalizationTool, { subscriptionId: "sub1", locale: "en-US", name: "Monthly+" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(updated.action, "updated");
  assert.equal(calls.find((c) => c.method === "PATCH")!.path, "/v1/subscriptionLocalizations/loc1");
});

test("asc_set_subscription_localization requires name on create", async () => {
  const { client } = fakeClient({ list: () => [] });
  await assert.rejects(
    () => setSubscriptionLocalizationTool.handler(parse(setSubscriptionLocalizationTool, { subscriptionId: "sub1", locale: "fr", description: "x" }), { client, config: cfg }),
    /name is required/,
  );
});

test("asc_list_subscription_price_points lists tiers for a territory", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "spp1", attributes: { customerPrice: "4.99" } }] });
  const out = await listSubscriptionPricePointsTool.handler(
    parse(listSubscriptionPricePointsTool, { subscriptionId: "sub1", territory: "GBR" }),
    { client, config: cfg },
  ) as Array<{ id: string; customerPrice?: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/subscriptions/sub1/pricePoints");
  assert.equal(out[0]!.id, "spp1");
  assert.equal(out[0]!.customerPrice, "4.99");
});

test("asc_set_subscription_availability posts explicit territories", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "avail1" } }) });
  await setSubscriptionAvailabilityTool.handler(parse(setSubscriptionAvailabilityTool, { subscriptionId: "sub1", territories: ["USA", "JPN"] }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "subscriptionAvailabilities");
  assert.deepEqual(body.data.relationships.subscription.data, { type: "subscriptions", id: "sub1" });
  assert.equal(body.data.relationships.availableTerritories.data.length, 2);
});

test("asc_set_subscription_availability expands availableInAllTerritories via /v1/territories", async () => {
  const { client, calls } = fakeClient({
    list: (path) => path === "/v1/territories" ? [{ id: "USA" }, { id: "JPN" }] : [],
    post: () => ({ data: { id: "avail1" } }),
  });
  await setSubscriptionAvailabilityTool.handler(parse(setSubscriptionAvailabilityTool, { subscriptionId: "sub1", availableInAllTerritories: true }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/territories");
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.relationships.availableTerritories.data.length, 2);
});

test("asc_upload_subscription_review_screenshot reserves, PUTs, and commits with an MD5", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sub-shot-"));
  const filePath = join(dir, "shot.png");
  await writeFile(filePath, randomBytes(2048));

  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => { res.statusCode = 200; res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const origin = `http://127.0.0.1:${addr.port}`;

  try {
    const { client, calls } = fakeClient({
      post: () => ({ data: { id: "shot1", attributes: { uploadOperations: [{ method: "PUT", url: `${origin}/p`, offset: 0, length: 2048, requestHeaders: [{ name: "Content-Type", value: "image/png" }] }] } } }),
      patch: () => ({ data: { id: "shot1", attributes: { assetDeliveryState: { state: "UPLOAD_COMPLETE" } } } }),
    });
    await uploadSubscriptionReviewScreenshotTool.handler({ subscriptionId: "sub1", filePath } as any, { client, config: cfg });
    const post = calls.find((c) => c.method === "POST")!;
    assert.equal(post.path, "/v1/subscriptionAppStoreReviewScreenshots");
    assert.deepEqual((post.body as any).data.relationships.subscription.data, { type: "subscriptions", id: "sub1" });
    const patch = calls.find((c) => c.method === "PATCH")!;
    assert.equal((patch.body as any).data.attributes.uploaded, true);
    assert.equal((patch.body as any).data.attributes.sourceFileChecksum.length, 32);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await unlink(filePath);
  }
});

test("asc_submit_subscription_for_review posts a group submission", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "gsub1", attributes: { state: "WAITING_FOR_REVIEW" } } }) });
  const out = await submitSubscriptionForReviewTool.handler(parse(submitSubscriptionForReviewTool, { subscriptionGroupId: "grp1" }), { client, config: cfg }) as any;
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/subscriptionGroupSubmissions");
  assert.deepEqual((post.body as any).data.relationships.subscriptionGroup.data, { type: "subscriptionGroups", id: "grp1" });
  assert.equal(out.submissionId, "gsub1");
  assert.equal(out.state, "WAITING_FOR_REVIEW");
});
