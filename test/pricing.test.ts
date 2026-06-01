import test from "node:test";
import assert from "node:assert/strict";
import { listAppPricePointsTool, getAppPriceScheduleTool, setAppPriceTool } from "../src/tools/pricing.ts";
import { setPhasedReleaseTool } from "../src/tools/metadata.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

// Handler tests against a recording stub client (the AscClient is covered in client.test.ts).
// Focus: the exact JSON:API payloads we send and the handler branching (free shortcut, explicit
// price point, phased-release upsert).

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  get?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async get(path: string) { calls.push({ method: "GET", path }); return responses.get?.(path); },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new" } }; },
    async patch(path: string, body: unknown) { calls.push({ method: "PATCH", path, body }); return responses.patch?.(path, body) ?? { data: { id: "patched" } }; },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_list_app_price_points lists tiers for a territory", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "app_pp_499", attributes: { customerPrice: "4.99" } }] });
  const out = await listAppPricePointsTool.handler(parse(listAppPricePointsTool, { appId: "app1", territory: "GBR" }), { client, config: cfg }) as Array<{ id: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/apps/app1/appPricePoints");
  assert.equal(out[0]!.id, "app_pp_499");
});

test("asc_get_app_price_schedule reads the schedule", async () => {
  const { client, calls } = fakeClient({ get: () => ({ data: { id: "sched1" } }) });
  await getAppPriceScheduleTool.handler(parse(getAppPriceScheduleTool, { appId: "app1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/apps/app1/appPriceSchedule");
});

test("asc_set_app_price resolves customerPrice and posts a self-consistent schedule", async () => {
  const { client, calls } = fakeClient({
    list: () => [{ id: "pp_099", attributes: { customerPrice: "0.99" } }, { id: "pp_499", attributes: { customerPrice: "4.99" } }],
    post: () => ({ data: { id: "sched1" } }),
  });
  const out = await setAppPriceTool.handler(
    parse(setAppPriceTool, { appId: "app1", baseTerritory: "USA", customerPrice: "4.99" }),
    { client, config: cfg },
  ) as { pricePointId: string };
  assert.equal(out.pricePointId, "pp_499");
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "appPriceSchedules");
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
  assert.equal(body.data.relationships.baseTerritory.data.id, "USA");
  const lid = body.data.relationships.manualPrices.data[0].id;
  const inc = body.included[0];
  assert.equal(inc.id, lid, "included appPrices id must match the manualPrices reference");
  assert.equal(inc.relationships.appPricePoint.data.id, "pp_499");
  assert.equal(inc.relationships.territory.data.id, "USA");
});

test("asc_set_app_price free=true selects the $0 tier", async () => {
  const { client } = fakeClient({
    list: () => [{ id: "pp_free", attributes: { customerPrice: "0.00" } }, { id: "pp_099", attributes: { customerPrice: "0.99" } }],
    post: () => ({ data: { id: "sched1" } }),
  });
  const out = await setAppPriceTool.handler(parse(setAppPriceTool, { appId: "app1", free: true }), { client, config: cfg }) as { pricePointId: string; free: boolean };
  assert.equal(out.pricePointId, "pp_free");
  assert.equal(out.free, true);
});

test("asc_set_app_price accepts an explicit pricePointId and skips the lookup", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "sched2" } }) });
  const out = await setAppPriceTool.handler(parse(setAppPriceTool, { appId: "app1", pricePointId: "pp_explicit" }), { client, config: cfg }) as { pricePointId: string };
  assert.equal(out.pricePointId, "pp_explicit");
  assert.equal(calls.some((c) => c.method === "LIST"), false, "no lookup when an id is given");
});

test("asc_set_app_price errors when no tier matches the customerPrice", async () => {
  const { client } = fakeClient({ list: () => [{ id: "pp_099", attributes: { customerPrice: "0.99" } }] });
  await assert.rejects(
    () => setAppPriceTool.handler(parse(setAppPriceTool, { appId: "app1", customerPrice: "3.33" }), { client, config: cfg }),
    /No price point/,
  );
});

test("asc_set_phased_release creates when absent, updates when present", async () => {
  // create path: no existing phased release
  const created = fakeClient({ get: () => ({ data: null }), post: () => ({ data: { id: "pr1", attributes: { phasedReleaseState: "ACTIVE" } } }) });
  const c = await setPhasedReleaseTool.handler(parse(setPhasedReleaseTool, { versionId: "v1", state: "ACTIVE" }), { client: created.client, config: cfg }) as { action: string };
  assert.equal(c.action, "created");
  const cbody = created.calls.find((x) => x.method === "POST")!.body as any;
  assert.equal(cbody.data.type, "appStoreVersionPhasedReleases");
  assert.equal(cbody.data.attributes.phasedReleaseState, "ACTIVE");
  assert.deepEqual(cbody.data.relationships.appStoreVersion.data, { type: "appStoreVersions", id: "v1" });

  // update path: existing phased release → PATCH to PAUSED
  const updated = fakeClient({ get: () => ({ data: { id: "pr1" } }), patch: () => ({ data: { id: "pr1" } }) });
  const u = await setPhasedReleaseTool.handler(parse(setPhasedReleaseTool, { versionId: "v1", state: "PAUSED" }), { client: updated.client, config: cfg }) as { action: string };
  assert.equal(u.action, "updated");
  const ppatch = updated.calls.find((x) => x.method === "PATCH")!;
  assert.equal(ppatch.path, "/v1/appStoreVersionPhasedReleases/pr1");
  assert.equal((ppatch.body as any).data.attributes.phasedReleaseState, "PAUSED");
});
