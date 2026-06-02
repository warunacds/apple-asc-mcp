import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  listInAppPurchasesTool, getInAppPurchaseTool, createInAppPurchaseTool, setIapLocalizationTool,
  setIapPriceTool, setIapAvailabilityTool, uploadIapReviewScreenshotTool, submitIapForReviewTool,
  deleteInAppPurchaseTool,
} from "../src/tools/iap.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

// These exercise the tool handlers (body shapes, upsert branching, price-point resolution) against a
// recording stub client — the AscClient itself is covered separately in client.test.ts. The handlers
// only ever call list/get/getOne/post/patch, so a small fake is enough and keeps the assertions about
// the exact JSON:API payloads we send to Apple.

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  get?: (path: string) => unknown;
  getOne?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
  del?: (path: string) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async get(path: string) { calls.push({ method: "GET", path }); return responses.get?.(path); },
    async getOne(path: string) { calls.push({ method: "GETONE", path }); return responses.getOne?.(path) ?? { id: "x", attributes: {} }; },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new", attributes: {} } }; },
    async patch(path: string, body: unknown) { calls.push({ method: "PATCH", path, body }); return responses.patch?.(path, body) ?? { data: { id: "patched", attributes: {} } }; },
    async delete(path: string) { calls.push({ method: "DELETE", path }); return responses.del?.(path); },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_create_in_app_purchase posts a correct JSON:API body", async () => {
  const { client, calls } = fakeClient({
    post: () => ({ data: { id: "iap1", attributes: { name: "Pro", productId: "com.x.pro", inAppPurchaseType: "NON_CONSUMABLE" } } }),
  });
  const out = await createInAppPurchaseTool.handler(
    parse(createInAppPurchaseTool, { appId: "app1", name: "Pro", productId: "com.x.pro", inAppPurchaseType: "NON_CONSUMABLE" }),
    { client, config: cfg },
  ) as { id: string };
  const post = calls.find((c) => c.method === "POST")!;
  const body = post.body as any;
  assert.equal(post.path, "/v2/inAppPurchases");
  assert.equal(body.data.type, "inAppPurchases");
  assert.equal(body.data.attributes.productId, "com.x.pro");
  assert.equal(body.data.attributes.inAppPurchaseType, "NON_CONSUMABLE");
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
  assert.equal(out.id, "iap1");
});

test("asc_set_iap_localization creates when absent, updates when present", async () => {
  let existing: unknown[] = [];
  const { client, calls } = fakeClient({
    list: () => existing,
    post: () => ({ data: { id: "loc1", attributes: { locale: "en-US", name: "Pro" } } }),
    patch: () => ({ data: { id: "loc1", attributes: { locale: "en-US", name: "Pro+" } } }),
  });

  const created = await setIapLocalizationTool.handler(
    parse(setIapLocalizationTool, { inAppPurchaseId: "iap1", locale: "en-US", name: "Pro", description: "All features" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(created.action, "created");
  const cbody = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(cbody.data.type, "inAppPurchaseLocalizations");
  assert.equal(cbody.data.attributes.locale, "en-US");
  assert.equal(cbody.data.attributes.description, "All features");
  // [VERIFY] localizations reference the purchase as inAppPurchaseV2 → resource type inAppPurchases.
  assert.deepEqual(cbody.data.relationships.inAppPurchaseV2.data, { type: "inAppPurchases", id: "iap1" });

  existing = [{ id: "loc1", attributes: { locale: "en-US" } }];
  const updated = await setIapLocalizationTool.handler(
    parse(setIapLocalizationTool, { inAppPurchaseId: "iap1", locale: "en-US", name: "Pro+" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(updated.action, "updated");
  assert.equal(calls.find((c) => c.method === "PATCH")!.path, "/v1/inAppPurchaseLocalizations/loc1");
});

test("asc_set_iap_localization requires name when creating a new locale", async () => {
  const { client } = fakeClient({ list: () => [] });
  await assert.rejects(
    () => setIapLocalizationTool.handler(parse(setIapLocalizationTool, { inAppPurchaseId: "iap1", locale: "fr", description: "x" }), { client, config: cfg }),
    /name is required/,
  );
});

test("asc_set_iap_price resolves customerPrice and posts a self-consistent price schedule", async () => {
  const { client, calls } = fakeClient({
    list: (path) => path.includes("/pricePoints")
      ? [{ id: "pp_low", attributes: { customerPrice: "0.99" } }, { id: "pp_hi", attributes: { customerPrice: "4.99" } }]
      : [],
    post: () => ({ data: { id: "sched1" } }),
  });
  const out = await setIapPriceTool.handler(
    parse(setIapPriceTool, { inAppPurchaseId: "iap1", baseTerritory: "USA", customerPrice: "4.99" }),
    { client, config: cfg },
  ) as { pricePointId: string };
  assert.equal(out.pricePointId, "pp_hi");

  const post = calls.find((c) => c.method === "POST")!;
  const body = post.body as any;
  assert.equal(post.path, "/v1/inAppPurchasePriceSchedules");
  assert.equal(body.data.relationships.baseTerritory.data.id, "USA");
  // The inline manual price must reference the same placeholder id in both places, else ASC 400s.
  const lid = body.data.relationships.manualPrices.data[0].id;
  const inc = body.included[0];
  assert.equal(inc.id, lid);
  assert.equal(inc.relationships.inAppPurchasePricePoint.data.id, "pp_hi");
  assert.equal(inc.relationships.territory.data.id, "USA");
});

test("asc_set_iap_price errors clearly when the customerPrice has no matching tier", async () => {
  const { client } = fakeClient({
    list: () => [{ id: "pp_low", attributes: { customerPrice: "0.99" } }],
  });
  await assert.rejects(
    () => setIapPriceTool.handler(parse(setIapPriceTool, { inAppPurchaseId: "iap1", baseTerritory: "USA", customerPrice: "2.49" }), { client, config: cfg }),
    /No price point/,
  );
});

test("asc_upload_iap_review_screenshot reserves, PUTs bytes, and commits with an MD5", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iap-shot-"));
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
    await uploadIapReviewScreenshotTool.handler({ inAppPurchaseId: "iap1", filePath } as any, { client, config: cfg });

    const post = calls.find((c) => c.method === "POST")!;
    assert.equal(post.path, "/v1/inAppPurchaseAppStoreReviewScreenshots");
    assert.deepEqual((post.body as any).data.relationships.inAppPurchaseV2.data, { type: "inAppPurchases", id: "iap1" });

    const patch = calls.find((c) => c.method === "PATCH")!;
    const pbody = patch.body as any;
    assert.equal(pbody.data.attributes.uploaded, true);
    assert.equal(pbody.data.attributes.sourceFileChecksum.length, 32);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await unlink(filePath);
  }
});

test("asc_list_in_app_purchases hits the app's IAP collection and flattens results", async () => {
  const { client, calls } = fakeClient({
    list: () => [{ id: "iap1", attributes: { name: "Pro", productId: "com.x.pro", inAppPurchaseType: "NON_CONSUMABLE", state: "APPROVED" } }],
  });
  const out = await listInAppPurchasesTool.handler(
    parse(listInAppPurchasesTool, { appId: "app1", inAppPurchaseType: "NON_CONSUMABLE" }),
    { client, config: cfg },
  ) as Array<{ id: string; productId?: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/apps/app1/inAppPurchasesV2");
  assert.equal(out[0]!.id, "iap1");
  assert.equal(out[0]!.productId, "com.x.pro");
});

test("asc_get_in_app_purchase assembles the IAP with its sub-resources", async () => {
  const { client, calls } = fakeClient({
    getOne: () => ({ id: "iap1", attributes: { name: "Pro", productId: "com.x.pro", state: "APPROVED" } }),
    list: () => [{ id: "loc1", attributes: { locale: "en-US", name: "Pro" } }],
    get: (path) => ({ data: { id: path.includes("Availability") ? "avail1" : "sched1" } }),
  });
  const out = await getInAppPurchaseTool.handler(parse(getInAppPurchaseTool, { inAppPurchaseId: "iap1" }), { client, config: cfg }) as any;
  assert.equal(calls.find((c) => c.method === "GETONE")!.path, "/v2/inAppPurchases/iap1");
  assert.equal(out.id, "iap1");
  assert.equal(out.productId, "com.x.pro");
  assert.equal(out.localizations[0].locale, "en-US");
  assert.ok(out.priceSchedule);
  assert.ok(out.availability);
});

test("asc_get_in_app_purchase degrades failing sub-resources to null/[]", async () => {
  const { client } = fakeClient({
    getOne: () => ({ id: "iap1", attributes: {} }),
    list: () => { throw new Error("boom"); },
    get: () => { throw new Error("boom"); },
  });
  const out = await getInAppPurchaseTool.handler(parse(getInAppPurchaseTool, { inAppPurchaseId: "iap1" }), { client, config: cfg }) as any;
  assert.deepEqual(out.localizations, []);
  assert.equal(out.priceSchedule, null);
  assert.equal(out.availability, null);
});

test("asc_set_iap_availability posts explicit territories", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "avail1" } }) });
  await setIapAvailabilityTool.handler(parse(setIapAvailabilityTool, { inAppPurchaseId: "iap1", territories: ["USA", "GBR"] }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "inAppPurchaseAvailabilities");
  assert.deepEqual(body.data.relationships.inAppPurchase.data, { type: "inAppPurchases", id: "iap1" });
  assert.deepEqual(body.data.relationships.availableTerritories.data, [{ type: "territories", id: "USA" }, { type: "territories", id: "GBR" }]);
  assert.equal(body.data.attributes.availableInNewTerritories, true);
});

test("asc_set_iap_availability expands availableInAllTerritories via /v1/territories", async () => {
  const { client, calls } = fakeClient({
    list: (path) => path === "/v1/territories" ? [{ id: "USA" }, { id: "GBR" }, { id: "JPN" }] : [],
    post: () => ({ data: { id: "avail1" } }),
  });
  await setIapAvailabilityTool.handler(
    parse(setIapAvailabilityTool, { inAppPurchaseId: "iap1", availableInAllTerritories: true, availableInNewTerritories: false }),
    { client, config: cfg },
  );
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/territories");
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.relationships.availableTerritories.data.length, 3);
  assert.equal(body.data.attributes.availableInNewTerritories, false);
});

test("asc_set_iap_price accepts an explicit pricePointId and skips the lookup", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "sched2" } }) });
  const out = await setIapPriceTool.handler(
    parse(setIapPriceTool, { inAppPurchaseId: "iap1", baseTerritory: "USA", pricePointId: "pp_explicit" }),
    { client, config: cfg },
  ) as { pricePointId: string };
  assert.equal(out.pricePointId, "pp_explicit");
  assert.equal(calls.some((c) => c.method === "LIST"), false, "no price-point lookup when an id is given");
  const inc = (calls.find((c) => c.method === "POST")!.body as any).included[0];
  assert.equal(inc.relationships.inAppPurchasePricePoint.data.id, "pp_explicit");
});

test("asc_submit_iap_for_review posts an inAppPurchaseSubmissions with the right relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "isub1", attributes: { state: "WAITING_FOR_REVIEW" } } }) });
  const out = await submitIapForReviewTool.handler(parse(submitIapForReviewTool, { inAppPurchaseId: "iap1" }), { client, config: cfg }) as any;
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/inAppPurchaseSubmissions");
  assert.deepEqual((post.body as any).data.relationships.inAppPurchaseV2.data, { type: "inAppPurchases", id: "iap1" });
  assert.equal(out.submissionId, "isub1");
  assert.equal(out.state, "WAITING_FOR_REVIEW");
});

test("asc_delete_in_app_purchase DELETEs the v2 resource", async () => {
  const { client, calls } = fakeClient({});
  const out = await deleteInAppPurchaseTool.handler(parse(deleteInAppPurchaseTool, { inAppPurchaseId: "iap1" }), { client, config: cfg }) as { deleted: string };
  const del = calls.find((c) => c.method === "DELETE")!;
  assert.equal(del.path, "/v2/inAppPurchases/iap1");
  assert.equal(out.deleted, "iap1");
});
