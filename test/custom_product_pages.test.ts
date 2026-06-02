import test from "node:test";
import assert from "node:assert/strict";
import {
  listCustomProductPagesTool, createCustomProductPageTool, getCustomProductPageTool,
  setCustomProductPageLocalizationTool, deleteCustomProductPageTool,
} from "../src/tools/custom_product_pages.ts";
import { findOrCreateScreenshotSetTool, findOrCreatePreviewSetTool } from "../src/tools/screenshots.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  getOne?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
  del?: (path: string) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async getOne(path: string) { calls.push({ method: "GETONE", path }); return responses.getOne?.(path) ?? { id: "x", attributes: {} }; },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new", attributes: {} } }; },
    async patch(path: string, body: unknown) { calls.push({ method: "PATCH", path, body }); return responses.patch?.(path, body) ?? { data: { id: "patched", attributes: {} } }; },
    async delete(path: string) { calls.push({ method: "DELETE", path }); return responses.del?.(path); },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_create_custom_product_page creates the page then resolves its draft version", async () => {
  const { client, calls } = fakeClient({
    list: () => [{ id: "ver1", attributes: { state: "PREPARE_FOR_SUBMISSION", version: "1" } }],
    post: (path) => path === "/v1/appCustomProductPages"
      ? { data: { id: "cpp1", attributes: { name: "Campaign A", visible: false } } }
      : { data: { id: "ver_new" } },
  });
  const out = await createCustomProductPageTool.handler(
    parse(createCustomProductPageTool, { appId: "app1", name: "Campaign A" }),
    { client, config: cfg },
  ) as { customProductPageId: string; versionId: string };
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/appCustomProductPages");
  assert.equal((post.body as any).data.attributes.name, "Campaign A");
  assert.deepEqual((post.body as any).data.relationships.app.data, { type: "apps", id: "app1" });
  assert.equal(out.customProductPageId, "cpp1");
  // It read the page's versions and returned the editable one rather than creating a new version.
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/appCustomProductPages/cpp1/appCustomProductPageVersions");
  assert.equal(out.versionId, "ver1");
});

test("asc_create_custom_product_page creates a version when none exists", async () => {
  const { client, calls } = fakeClient({
    list: () => [],
    post: (path) => path === "/v1/appCustomProductPages"
      ? { data: { id: "cpp2", attributes: {} } }
      : { data: { id: "ver_made" } },
  });
  const out = await createCustomProductPageTool.handler(
    parse(createCustomProductPageTool, { appId: "app1", name: "Campaign B" }),
    { client, config: cfg },
  ) as { versionId: string };
  const verPost = calls.filter((c) => c.method === "POST").find((c) => c.path === "/v1/appCustomProductPageVersions")!;
  assert.deepEqual((verPost.body as any).data.relationships.appCustomProductPage.data, { type: "appCustomProductPages", id: "cpp2" });
  assert.equal(out.versionId, "ver_made");
});

test("asc_set_custom_product_page_localization upserts on a version", async () => {
  let existing: unknown[] = [];
  const { client, calls } = fakeClient({
    list: () => existing,
    post: () => ({ data: { id: "cloc1", attributes: { locale: "en-US", promotionalText: "Try it" } } }),
    patch: () => ({ data: { id: "cloc1", attributes: { locale: "en-US", promotionalText: "Try it now" } } }),
  });
  const created = await setCustomProductPageLocalizationTool.handler(
    parse(setCustomProductPageLocalizationTool, { versionId: "ver1", locale: "en-US", promotionalText: "Try it" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(created.action, "created");
  const cbody = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(cbody.data.type, "appCustomProductPageLocalizations");
  assert.deepEqual(cbody.data.relationships.appCustomProductPageVersion.data, { type: "appCustomProductPageVersions", id: "ver1" });

  existing = [{ id: "cloc1", attributes: { locale: "en-US" } }];
  const updated = await setCustomProductPageLocalizationTool.handler(
    parse(setCustomProductPageLocalizationTool, { versionId: "ver1", locale: "en-US", promotionalText: "Try it now" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(updated.action, "updated");
  assert.equal(calls.find((c) => c.method === "PATCH")!.path, "/v1/appCustomProductPageLocalizations/cloc1");
});

test("asc_list / asc_get / asc_delete custom product page", async () => {
  const { client, calls } = fakeClient({
    list: (path) => path.includes("appCustomProductPageVersions") ? [{ id: "ver1", attributes: { state: "PREPARE_FOR_SUBMISSION" } }]
      : path.includes("appCustomProductPageLocalizations") ? [{ id: "cloc1", attributes: { locale: "en-US" } }]
      : [{ id: "cpp1", attributes: { name: "A", url: "https://apps.apple.com/x", visible: true } }],
    getOne: () => ({ id: "cpp1", attributes: { name: "A", url: "https://apps.apple.com/x", visible: true } }),
  });
  const list = await listCustomProductPagesTool.handler(parse(listCustomProductPagesTool, { appId: "app1" }), { client, config: cfg }) as Array<{ url?: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/apps/app1/appCustomProductPages");
  assert.equal(list[0]!.url, "https://apps.apple.com/x");

  const got = await getCustomProductPageTool.handler(parse(getCustomProductPageTool, { customProductPageId: "cpp1" }), { client, config: cfg }) as { draftVersionId?: string };
  assert.equal(got.draftVersionId, "ver1");

  await deleteCustomProductPageTool.handler(parse(deleteCustomProductPageTool, { customProductPageId: "cpp1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "DELETE")!.path, "/v1/appCustomProductPages/cpp1");
});

test("screenshot/preview set tools target a CPP localization when given one", async () => {
  const { client, calls } = fakeClient({ list: () => [], post: () => ({ data: { id: "set1" } }) });
  await findOrCreateScreenshotSetTool.handler(
    parse(findOrCreateScreenshotSetTool, { customProductPageLocalizationId: "cloc1", displayType: "APP_IPHONE_67" }),
    { client, config: cfg },
  );
  // It lists/creates under the CPP localization, not a version localization.
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/appCustomProductPageLocalizations/cloc1/appScreenshotSets");
  const sbody = calls.find((c) => c.method === "POST")!.body as any;
  assert.deepEqual(sbody.data.relationships.appCustomProductPageLocalization.data, { type: "appCustomProductPageLocalizations", id: "cloc1" });
  assert.equal("appStoreVersionLocalization" in sbody.data.relationships, false);

  // And it still rejects ambiguous / empty parents.
  assert.throws(() => parse(findOrCreatePreviewSetTool, { localizationId: "l1", customProductPageLocalizationId: "c1", previewType: "IPHONE_67" }));
  assert.throws(() => parse(findOrCreatePreviewSetTool, { previewType: "IPHONE_67" }));
});
