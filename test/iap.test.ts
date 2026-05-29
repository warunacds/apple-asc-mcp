import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createInAppPurchaseTool, setIapLocalizationTool, setIapPriceTool, uploadIapReviewScreenshotTool,
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
