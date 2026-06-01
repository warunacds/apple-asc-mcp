import test from "node:test";
import assert from "node:assert/strict";
import {
  listPrivacyOptionsTool, getPrivacyDetailsTool, addDataUsageTool, removeDataUsageTool,
  declareNoDataCollectedTool, publishPrivacyTool,
} from "../src/tools/privacy.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

// Handler tests against a recording stub client (the AscClient is covered in client.test.ts).
// Focus: the appDataUsages relationship payloads, the no-data-collected resolution, and the publish PATCH.

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  get?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
  del?: (path: string) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async get(path: string) { calls.push({ method: "GET", path }); return responses.get?.(path); },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new" } }; },
    async patch(path: string, body: unknown) { calls.push({ method: "PATCH", path, body }); return responses.patch?.(path, body) ?? { data: { id: "patched" } }; },
    async delete(path: string) { calls.push({ method: "DELETE", path }); return responses.del?.(path); },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_list_privacy_options reads all three reference lists", async () => {
  const { client, calls } = fakeClient({
    list: (path) => path.includes("Categories") ? [{ id: "cat_email" }]
      : path.includes("Purposes") ? [{ id: "pur_analytics" }]
      : [{ id: "DATA_NOT_COLLECTED" }],
  });
  const out = await listPrivacyOptionsTool.handler(parse(listPrivacyOptionsTool, {}), { client, config: cfg }) as { categories: unknown[]; purposes: unknown[]; dataProtections: unknown[] };
  const paths = calls.filter((c) => c.method === "LIST").map((c) => c.path);
  assert.ok(paths.includes("/v1/appDataUsageCategories"));
  assert.ok(paths.includes("/v1/appDataUsagePurposes"));
  assert.ok(paths.includes("/v1/appDataUsageDataProtections"));
  assert.equal((out.categories[0] as { id: string }).id, "cat_email");
});

test("asc_get_privacy_details returns usages + published flag", async () => {
  const { client } = fakeClient({
    get: (path) => path.endsWith("appDataUsagesPublishState")
      ? { data: { id: "ps1", attributes: { published: true } } }
      : { data: [{ id: "du1" }] },
  });
  const out = await getPrivacyDetailsTool.handler(parse(getPrivacyDetailsTool, { appId: "app1" }), { client, config: cfg }) as { published: boolean | null; publishStateId: string | null };
  assert.equal(out.published, true);
  assert.equal(out.publishStateId, "ps1");
});

test("asc_add_data_usage posts the app/category/purpose/dataProtection relationships", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "du1" } }) });
  await addDataUsageTool.handler(
    parse(addDataUsageTool, { appId: "app1", categoryId: "cat_email", purposeId: "pur_analytics", dataProtectionId: "DATA_LINKED_TO_YOU" }),
    { client, config: cfg },
  );
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "appDataUsages");
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
  assert.deepEqual(body.data.relationships.category.data, { type: "appDataUsageCategories", id: "cat_email" });
  assert.deepEqual(body.data.relationships.purpose.data, { type: "appDataUsagePurposes", id: "pur_analytics" });
  assert.deepEqual(body.data.relationships.dataProtection.data, { type: "appDataUsageDataProtections", id: "DATA_LINKED_TO_YOU" });
});

test("asc_add_data_usage omits purpose for protection-only rows", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "du2" } }) });
  await addDataUsageTool.handler(
    parse(addDataUsageTool, { appId: "app1", categoryId: "cat_id", dataProtectionId: "DATA_USED_TO_TRACK_YOU" }),
    { client, config: cfg },
  );
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.relationships.purpose, undefined);
});

test("asc_declare_no_data_collected resolves the protection id and posts a protection-only usage", async () => {
  const { client, calls } = fakeClient({
    list: () => [{ id: "DATA_LINKED_TO_YOU" }, { id: "DATA_NOT_COLLECTED" }],
    post: () => ({ data: { id: "du_none" } }),
  });
  await declareNoDataCollectedTool.handler(parse(declareNoDataCollectedTool, { appId: "app1" }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.relationships.dataProtection.data.id, "DATA_NOT_COLLECTED");
  assert.equal(body.data.relationships.category, undefined, "no category on a no-data-collected row");
  assert.equal(body.data.relationships.purpose, undefined);
});

test("asc_publish_privacy fetches the publish-state id then PATCHes published=true", async () => {
  const { client, calls } = fakeClient({
    get: () => ({ data: { id: "ps1" } }),
    patch: () => ({ data: { id: "ps1" } }),
  });
  await publishPrivacyTool.handler(parse(publishPrivacyTool, { appId: "app1" }), { client, config: cfg });
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v1/appDataUsagesPublishStates/ps1");
  assert.equal((patch.body as any).data.attributes.published, true);
});

test("asc_remove_data_usage DELETEs the usage", async () => {
  const { client, calls } = fakeClient({});
  await removeDataUsageTool.handler(parse(removeDataUsageTool, { dataUsageId: "du1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "DELETE")!.path, "/v1/appDataUsages/du1");
});
