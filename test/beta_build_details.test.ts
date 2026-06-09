import test from "node:test";
import assert from "node:assert/strict";
import {
  getBuildBetaDetailTool, updateBuildBetaDetailTool, setBuildBetaLocalizationTool,
  listBuildBetaLocalizationsTool, listBetaGroupsForBuildTool, addBuildToBetaGroupsTool,
  addTestersToBuildTool, removeTestersFromBuildTool, listBuildIndividualTestersTool,
  sendBuildBetaNotificationTool,
} from "../src/tools/beta_build_details.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

interface Call { method: string; path: string; body?: unknown; }

// Like the app_events fake, but extended so delete(path, opts) records opts?.body — the new
// DELETE-with-body tool needs the body asserted, and getOne/get back the two-step beta detail read.
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
    async get(path: string) { calls.push({ method: "GET", path }); return responses.get?.(path) ?? { data: { id: "g", attributes: {} } }; },
    async getOne(path: string) { calls.push({ method: "GETONE", path }); return responses.getOne?.(path) ?? { id: "one", attributes: {} }; },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new", attributes: {} } }; },
    async patch(path: string, body: unknown) { calls.push({ method: "PATCH", path, body }); return responses.patch?.(path, body) ?? { data: { id: "patched", attributes: {} } }; },
    async delete(path: string, opts?: { body?: unknown }) { calls.push({ method: "DELETE", path, body: opts?.body }); return responses.del?.(path); },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_get_build_beta_detail two-steps: build relationship → buildBetaDetails", async () => {
  const { client, calls } = fakeClient({
    getOne: () => ({ id: "b1", relationships: { buildBetaDetail: { data: { id: "bd1" } } } }),
    get: () => ({ data: { id: "bd1", attributes: { autoNotifyEnabled: true } } }),
  });
  const out = await getBuildBetaDetailTool.handler(parse(getBuildBetaDetailTool, { buildId: "b1" }), { client, config: cfg }) as any;
  assert.equal(calls.find((c) => c.method === "GETONE")!.path, "/v1/builds/b1");
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/buildBetaDetails/bd1");
  assert.equal(out.data.id, "bd1");
});

test("asc_get_build_beta_detail returns betaDetail:null when relationship is absent", async () => {
  const { client, calls } = fakeClient({
    getOne: () => ({ id: "b1", relationships: { buildBetaDetail: { data: null } } }),
  });
  const out = await getBuildBetaDetailTool.handler(parse(getBuildBetaDetailTool, { buildId: "b1" }), { client, config: cfg }) as any;
  assert.deepEqual(out, { buildId: "b1", betaDetail: null });
  assert.equal(calls.find((c) => c.method === "GET"), undefined); // no second fetch
});

test("asc_update_build_beta_detail PATCHes provided attrs and rejects an empty update", async () => {
  const { client, calls } = fakeClient({});
  await updateBuildBetaDetailTool.handler(
    parse(updateBuildBetaDetailTool, { betaDetailId: "bd1", autoNotifyEnabled: false, internalBuildState: "IN_BETA_TESTING" }),
    { client, config: cfg },
  );
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v1/buildBetaDetails/bd1");
  assert.equal((patch.body as any).data.type, "buildBetaDetails");
  assert.equal((patch.body as any).data.attributes.autoNotifyEnabled, false);
  assert.equal((patch.body as any).data.attributes.internalBuildState, "IN_BETA_TESTING");
  await assert.rejects(
    () => updateBuildBetaDetailTool.handler(parse(updateBuildBetaDetailTool, { betaDetailId: "bd1" }), { client, config: cfg }),
    /at least one field/,
  );
});

test("asc_update_build_beta_detail rejects an out-of-enum build state", () => {
  assert.throws(() => parse(updateBuildBetaDetailTool, { betaDetailId: "bd1", externalBuildState: "NOPE" }));
});

test("asc_set_build_beta_localization creates with build relationship, then updates without it", async () => {
  let existing: unknown[] = [];
  const { client, calls } = fakeClient({
    list: () => existing,
    post: () => ({ data: { id: "loc1", attributes: { locale: "en-US" } } }),
    patch: () => ({ data: { id: "loc1", attributes: { locale: "en-US" } } }),
  });
  const created = await setBuildBetaLocalizationTool.handler(
    parse(setBuildBetaLocalizationTool, { buildId: "b1", locale: "en-US", whatsNew: "Try this", feedbackEmail: "qa@x.com" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(created.action, "created");
  const cbody = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(cbody.data.type, "betaBuildLocalizations");
  assert.equal(cbody.data.attributes.locale, "en-US");
  assert.equal(cbody.data.attributes.whatsNew, "Try this");
  assert.equal(cbody.data.attributes.feedbackEmail, "qa@x.com");
  assert.deepEqual(cbody.data.relationships.build.data, { type: "builds", id: "b1" });

  existing = [{ id: "loc1", attributes: { locale: "en-US" } }];
  const updated = await setBuildBetaLocalizationTool.handler(
    parse(setBuildBetaLocalizationTool, { buildId: "b1", locale: "en-US", whatsNew: "Try this v2" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(updated.action, "updated");
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v1/betaBuildLocalizations/loc1");
  assert.equal((patch.body as any).data.attributes.whatsNew, "Try this v2");
  assert.equal((patch.body as any).data.relationships, undefined); // update body carries no relationships
});

test("asc_set_build_beta_localization rejects whatsNew over 4000 chars", () => {
  assert.throws(() => parse(setBuildBetaLocalizationTool, { buildId: "b1", locale: "en-US", whatsNew: "x".repeat(4001) }));
});

test("asc_list_build_beta_localizations hits the build-scoped path", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "loc1", attributes: { locale: "en-US", whatsNew: "hi" } }] });
  const out = await listBuildBetaLocalizationsTool.handler(parse(listBuildBetaLocalizationsTool, { buildId: "b1" }), { client, config: cfg }) as Array<{ id: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/builds/b1/betaBuildLocalizations");
  assert.equal(out[0]!.id, "loc1");
});

test("asc_list_beta_groups_for_build lists /v1/betaGroups (filter[builds])", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "grp1", attributes: { name: "Internal" } }] });
  const out = await listBetaGroupsForBuildTool.handler(parse(listBetaGroupsForBuildTool, { buildId: "b1" }), { client, config: cfg }) as Array<{ id: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/betaGroups");
  assert.equal(out[0]!.id, "grp1");
});

test("asc_add_build_to_beta_groups POSTs a to-many betaGroups relationship body", async () => {
  const { client, calls } = fakeClient({});
  const out = await addBuildToBetaGroupsTool.handler(
    parse(addBuildToBetaGroupsTool, { buildId: "b1", groupIds: ["g1", "g2"] }),
    { client, config: cfg },
  ) as { ok: boolean };
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/builds/b1/relationships/betaGroups");
  assert.deepEqual((post.body as any).data, [{ type: "betaGroups", id: "g1" }, { type: "betaGroups", id: "g2" }]);
  assert.equal(out.ok, true);
});

test("asc_add_testers_to_build POSTs a betaTesters relationship body to individualTesters", async () => {
  const { client, calls } = fakeClient({});
  await addTestersToBuildTool.handler(parse(addTestersToBuildTool, { buildId: "b1", testerIds: ["t1"] }), { client, config: cfg });
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/builds/b1/relationships/individualTesters");
  assert.deepEqual((post.body as any).data, [{ type: "betaTesters", id: "t1" }]);
});

test("asc_remove_testers_from_build issues DELETE with a to-many body", async () => {
  const { client, calls } = fakeClient({});
  const out = await removeTestersFromBuildTool.handler(
    parse(removeTestersFromBuildTool, { buildId: "b1", testerIds: ["t1", "t2"] }),
    { client, config: cfg },
  ) as { ok: boolean };
  const del = calls.find((c) => c.method === "DELETE")!;
  assert.equal(del.path, "/v1/builds/b1/relationships/individualTesters");
  assert.deepEqual((del.body as any).data, [{ type: "betaTesters", id: "t1" }, { type: "betaTesters", id: "t2" }]);
  assert.equal(out.ok, true);
});

test("asc_list_build_individual_testers hits the individualTesters path", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "t1", attributes: { email: "a@b.com" } }] });
  const out = await listBuildIndividualTestersTool.handler(parse(listBuildIndividualTestersTool, { buildId: "b1" }), { client, config: cfg }) as Array<{ id: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/builds/b1/individualTesters");
  assert.equal(out[0]!.id, "t1");
});

test("asc_send_build_beta_notification POSTs the build relationship and returns ok", async () => {
  const { client, calls } = fakeClient({});
  const out = await sendBuildBetaNotificationTool.handler(parse(sendBuildBetaNotificationTool, { buildId: "b1" }), { client, config: cfg }) as { ok: boolean; buildId: string };
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/betaBuildNotifications");
  assert.equal((post.body as any).data.type, "betaBuildNotifications");
  assert.deepEqual((post.body as any).data.relationships.build.data, { type: "builds", id: "b1" });
  assert.deepEqual(out, { ok: true, buildId: "b1" });
});
