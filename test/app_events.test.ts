import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  listAppEventsTool, createAppEventTool, updateAppEventTool, setAppEventLocalizationTool,
  uploadAppEventScreenshotTool, deleteAppEventTool,
} from "../src/tools/app_events.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
  del?: (path: string) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new", attributes: {} } }; },
    async patch(path: string, body: unknown) { calls.push({ method: "PATCH", path, body }); return responses.patch?.(path, body) ?? { data: { id: "patched", attributes: {} } }; },
    async delete(path: string) { calls.push({ method: "DELETE", path }); return responses.del?.(path); },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_create_app_event posts referenceName + optional fields + app relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "ev1", attributes: { referenceName: "Summer" } } }) });
  await createAppEventTool.handler(parse(createAppEventTool, {
    appId: "app1", referenceName: "Summer", badge: "SPECIAL_EVENT", priority: "HIGH",
    purpose: "ATTRACT_NEW_USERS",
    territorySchedules: [{ territories: ["USA"], publishStart: "2026-07-01T00:00:00Z", eventStart: "2026-07-04T00:00:00Z", eventEnd: "2026-07-10T00:00:00Z" }],
  }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "appEvents");
  assert.equal(body.data.attributes.referenceName, "Summer");
  assert.equal(body.data.attributes.badge, "SPECIAL_EVENT");
  assert.equal(body.data.attributes.territorySchedules[0].territories[0], "USA");
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
});

test("asc_update_app_event PATCHes territorySchedules and rejects an empty update", async () => {
  const { client, calls } = fakeClient({});
  await updateAppEventTool.handler(parse(updateAppEventTool, {
    appEventId: "ev1",
    territorySchedules: [{ territories: ["GBR"], publishStart: "2026-07-01T00:00:00Z", eventStart: "2026-07-04T00:00:00Z", eventEnd: "2026-07-10T00:00:00Z" }],
  }), { client, config: cfg });
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v1/appEvents/ev1");
  assert.equal((patch.body as any).data.attributes.territorySchedules[0].territories[0], "GBR");
  await assert.rejects(() => updateAppEventTool.handler(parse(updateAppEventTool, { appEventId: "ev1" }), { client, config: cfg }), /at least one field/);
});

test("asc_set_app_event_localization creates then updates", async () => {
  let existing: unknown[] = [];
  const { client, calls } = fakeClient({
    list: () => existing,
    post: () => ({ data: { id: "loc1", attributes: { locale: "en-US", name: "Summer Sale" } } }),
    patch: () => ({ data: { id: "loc1", attributes: { locale: "en-US", name: "Summer Sale!" } } }),
  });
  const created = await setAppEventLocalizationTool.handler(
    parse(setAppEventLocalizationTool, { appEventId: "ev1", locale: "en-US", name: "Summer Sale", shortDescription: "Save big" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(created.action, "created");
  const cbody = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(cbody.data.type, "appEventLocalizations");
  assert.equal(cbody.data.attributes.shortDescription, "Save big");
  assert.deepEqual(cbody.data.relationships.appEvent.data, { type: "appEvents", id: "ev1" });

  existing = [{ id: "loc1", attributes: { locale: "en-US" } }];
  const updated = await setAppEventLocalizationTool.handler(
    parse(setAppEventLocalizationTool, { appEventId: "ev1", locale: "en-US", name: "Summer Sale!" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(updated.action, "updated");
  assert.equal(calls.find((c) => c.method === "PATCH")!.path, "/v1/appEventLocalizations/loc1");
});

test("asc_set_app_event_localization requires name on first create", async () => {
  const { client } = fakeClient({ list: () => [] });
  await assert.rejects(
    () => setAppEventLocalizationTool.handler(parse(setAppEventLocalizationTool, { appEventId: "ev1", locale: "fr", shortDescription: "x" }), { client, config: cfg }),
    /name is required/,
  );
});

test("asc_upload_app_event_screenshot reserves with assetType + localization, PUTs, commits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ev-shot-"));
  const filePath = join(dir, "card.png");
  await writeFile(filePath, randomBytes(1024));
  const server = createServer((req, res) => { req.on("data", () => {}); req.on("end", () => { res.statusCode = 200; res.end(); }); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const origin = `http://127.0.0.1:${addr.port}`;
  try {
    const { client, calls } = fakeClient({
      post: () => ({ data: { id: "es1", attributes: { uploadOperations: [{ method: "PUT", url: `${origin}/p`, offset: 0, length: 1024, requestHeaders: [{ name: "Content-Type", value: "image/png" }] }] } } }),
      patch: () => ({ data: { id: "es1", attributes: { assetDeliveryState: { state: "UPLOAD_COMPLETE" } } } }),
    });
    await uploadAppEventScreenshotTool.handler({ appEventLocalizationId: "loc1", filePath, assetType: "EVENT_CARD" } as any, { client, config: cfg });
    const post = calls.find((c) => c.method === "POST")!;
    assert.equal(post.path, "/v1/appEventScreenshots");
    assert.equal((post.body as any).data.attributes.appEventAssetType, "EVENT_CARD");
    assert.deepEqual((post.body as any).data.relationships.appEventLocalization.data, { type: "appEventLocalizations", id: "loc1" });
    const patch = calls.find((c) => c.method === "PATCH")!;
    assert.equal((patch.body as any).data.attributes.uploaded, true);
    assert.equal((patch.body as any).data.attributes.sourceFileChecksum.length, 32);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await unlink(filePath);
  }
});

test("asc_list_app_events / asc_delete_app_event hit the right paths", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "ev1", attributes: { referenceName: "Summer", eventState: "DRAFT" } }] });
  const out = await listAppEventsTool.handler(parse(listAppEventsTool, { appId: "app1" }), { client, config: cfg }) as Array<{ id: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/apps/app1/appEvents");
  assert.equal(out[0]!.id, "ev1");
  const del = await deleteAppEventTool.handler(parse(deleteAppEventTool, { appEventId: "ev1" }), { client, config: cfg }) as { deleted: string };
  assert.equal(calls.find((c) => c.method === "DELETE")!.path, "/v1/appEvents/ev1");
  assert.equal(del.deleted, "ev1");
});
