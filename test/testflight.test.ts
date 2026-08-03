import test from "node:test";
import assert from "node:assert/strict";
import {
  createBetaGroupTool, updateBetaGroupTool, deleteBetaGroupTool, addTestersToBetaGroupTool,
  removeTestersFromBetaGroupTool, listBetaGroupTestersTool, removeBuildsFromBetaGroupTool,
  listBetaTestersTool, searchBetaTestersTool, getBetaTesterTool, createBetaTesterTool,
  deleteBetaTesterTool, listBetaTesterAppsTool, sendBetaTesterInvitationTool,
  addBetaTesterToGroupsTool, removeBetaTesterFromGroupsTool, addBetaTesterToBuildsTool,
  removeBetaTesterFromBuildsTool, removeBetaTesterFromAppTool,
} from "../src/tools/testflight.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

interface Call { method: string; path: string; body?: unknown; query?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  get?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
  del?: (path: string) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string, query?: unknown) { calls.push({ method: "LIST", path, query }); return responses.list?.(path) ?? []; },
    async get(path: string, opts?: { query?: unknown }) { calls.push({ method: "GET", path, query: opts?.query }); return responses.get?.(path) ?? { data: { id: "g", attributes: {} } }; },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new", attributes: {} } }; },
    async patch(path: string, body: unknown) { calls.push({ method: "PATCH", path, body }); return responses.patch?.(path, body) ?? { data: { id: "patched", attributes: {} } }; },
    // The fake's delete records opts?.body so DELETE-with-body relationship removals can be asserted.
    async delete(path: string, opts?: { body?: unknown }) { calls.push({ method: "DELETE", path, body: opts?.body }); return responses.del?.(path); },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

// ── Beta Groups ─────────────────────────────────────────────────────────────

test("asc_create_beta_group posts name + only provided booleans + app relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "bg1", attributes: { name: "Friends" } } }) });
  await createBetaGroupTool.handler(parse(createBetaGroupTool, {
    appId: "app1", name: "Friends", publicLinkEnabled: true,
  }), { client, config: cfg });
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/betaGroups");
  const body = post.body as any;
  assert.equal(body.data.type, "betaGroups");
  assert.equal(body.data.attributes.name, "Friends");
  assert.equal(body.data.attributes.publicLinkEnabled, true);
  assert.equal("isInternalGroup" in body.data.attributes, false);
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
});

test("asc_update_beta_group PATCHes only provided fields and rejects an empty update", async () => {
  const { client, calls } = fakeClient({});
  await updateBetaGroupTool.handler(parse(updateBetaGroupTool, {
    betaGroupId: "bg1", name: "Renamed", publicLinkLimit: 50,
  }), { client, config: cfg });
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v1/betaGroups/bg1");
  const body = patch.body as any;
  assert.equal(body.data.type, "betaGroups");
  assert.equal(body.data.id, "bg1");
  assert.equal(body.data.attributes.name, "Renamed");
  assert.equal(body.data.attributes.publicLinkLimit, 50);
  assert.equal("feedbackEnabled" in body.data.attributes, false);
  await assert.rejects(
    () => updateBetaGroupTool.handler(parse(updateBetaGroupTool, { betaGroupId: "bg1" }), { client, config: cfg }),
    /at least one field/,
  );
});

test("asc_delete_beta_group DELETEs and returns ok", async () => {
  const { client, calls } = fakeClient({});
  const out = await deleteBetaGroupTool.handler(parse(deleteBetaGroupTool, { betaGroupId: "bg1" }), { client, config: cfg }) as { ok: boolean; betaGroupId: string };
  assert.equal(calls.find((c) => c.method === "DELETE")!.path, "/v1/betaGroups/bg1");
  assert.equal(out.ok, true);
  assert.equal(out.betaGroupId, "bg1");
});

test("asc_add_testers_to_beta_group POSTs to the relationship endpoint with a betaTesters array", async () => {
  const { client, calls } = fakeClient({});
  await addTestersToBetaGroupTool.handler(parse(addTestersToBetaGroupTool, {
    betaGroupId: "bg1", testerIds: ["t1", "t2"],
  }), { client, config: cfg });
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/betaGroups/bg1/relationships/betaTesters");
  assert.deepEqual((post.body as any).data, [{ type: "betaTesters", id: "t1" }, { type: "betaTesters", id: "t2" }]);
});

test("asc_remove_testers_from_beta_group DELETEs with a JSON:API body (DELETE-with-body)", async () => {
  const { client, calls } = fakeClient({});
  await removeTestersFromBetaGroupTool.handler(parse(removeTestersFromBetaGroupTool, {
    betaGroupId: "bg1", testerIds: ["t1"],
  }), { client, config: cfg });
  const del = calls.find((c) => c.method === "DELETE")!;
  assert.equal(del.path, "/v1/betaGroups/bg1/relationships/betaTesters");
  assert.deepEqual((del.body as any).data, [{ type: "betaTesters", id: "t1" }]);
});

test("asc_list_beta_group_testers lists testers and maps id + attributes", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "t1", attributes: { email: "a@b.com" } }] });
  const out = await listBetaGroupTestersTool.handler(parse(listBetaGroupTestersTool, { betaGroupId: "bg1" }), { client, config: cfg }) as Array<{ id: string; email: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/betaGroups/bg1/betaTesters");
  assert.equal(out[0]!.id, "t1");
  assert.equal(out[0]!.email, "a@b.com");
});

test("asc_remove_builds_from_beta_group DELETEs with a builds body (DELETE-with-body)", async () => {
  const { client, calls } = fakeClient({});
  await removeBuildsFromBetaGroupTool.handler(parse(removeBuildsFromBetaGroupTool, {
    betaGroupId: "bg1", buildIds: ["b1", "b2"],
  }), { client, config: cfg });
  const del = calls.find((c) => c.method === "DELETE")!;
  assert.equal(del.path, "/v1/betaGroups/bg1/relationships/builds");
  assert.deepEqual((del.body as any).data, [{ type: "builds", id: "b1" }, { type: "builds", id: "b2" }]);
});

// ── Beta Testers ────────────────────────────────────────────────────────────

test("asc_list_beta_testers uses filter[apps] (plural) when appId is given", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "t1", attributes: { email: "a@b.com" } }] });
  await listBetaTestersTool.handler(parse(listBetaTestersTool, { appId: "app1" }), { client, config: cfg });
  const list = calls.find((c) => c.method === "LIST")!;
  assert.equal(list.path, "/v1/betaTesters");
  assert.equal((list.query as any)["filter[apps]"], "app1");
});

test("asc_search_beta_testers filters by exact email", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "t1", attributes: { email: "a@b.com" } }] });
  await searchBetaTestersTool.handler(parse(searchBetaTestersTool, { email: "a@b.com" }), { client, config: cfg });
  const list = calls.find((c) => c.method === "LIST")!;
  assert.equal(list.path, "/v1/betaTesters");
  assert.equal((list.query as any)["filter[email]"], "a@b.com");
});

test("asc_get_beta_tester passes the include array through", async () => {
  const { client, calls } = fakeClient({ get: () => ({ data: { id: "t1", attributes: {} } }) });
  await getBetaTesterTool.handler(parse(getBetaTesterTool, { betaTesterId: "t1", include: ["apps", "betaGroups"] }), { client, config: cfg });
  const get = calls.find((c) => c.method === "GET")!;
  assert.equal(get.path, "/v1/betaTesters/t1");
  assert.deepEqual((get.query as any).include, ["apps", "betaGroups"]);
});

test("asc_create_beta_tester posts email + null names + betaGroups relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "t1", attributes: { email: "a@b.com" } } }) });
  await createBetaTesterTool.handler(parse(createBetaTesterTool, {
    email: "a@b.com", groupIds: ["bg1", "bg2"], firstName: "Ada",
  }), { client, config: cfg });
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/betaTesters");
  const body = post.body as any;
  assert.equal(body.data.type, "betaTesters");
  assert.equal(body.data.attributes.email, "a@b.com");
  assert.equal(body.data.attributes.firstName, "Ada");
  assert.equal(body.data.attributes.lastName, null);
  assert.deepEqual(body.data.relationships.betaGroups.data, [{ type: "betaGroups", id: "bg1" }, { type: "betaGroups", id: "bg2" }]);
});

test("asc_delete_beta_tester DELETEs the tester", async () => {
  const { client, calls } = fakeClient({});
  const out = await deleteBetaTesterTool.handler(parse(deleteBetaTesterTool, { betaTesterId: "t1" }), { client, config: cfg }) as { ok: boolean; betaTesterId: string };
  assert.equal(calls.find((c) => c.method === "DELETE")!.path, "/v1/betaTesters/t1");
  assert.equal(out.betaTesterId, "t1");
});

test("asc_list_beta_tester_apps lists a tester's apps", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "app1", attributes: { name: "MyApp" } }] });
  const out = await listBetaTesterAppsTool.handler(parse(listBetaTesterAppsTool, { betaTesterId: "t1" }), { client, config: cfg }) as Array<{ id: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/betaTesters/t1/apps");
  assert.equal(out[0]!.id, "app1");
});

test("asc_send_beta_tester_invitation posts betaTester + app relationships", async () => {
  const { client, calls } = fakeClient({});
  await sendBetaTesterInvitationTool.handler(parse(sendBetaTesterInvitationTool, { betaTesterId: "t1", appId: "app1" }), { client, config: cfg });
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/betaTesterInvitations");
  const body = post.body as any;
  assert.equal(body.data.type, "betaTesterInvitations");
  assert.deepEqual(body.data.relationships.betaTester.data, { type: "betaTesters", id: "t1" });
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
});

test("asc_add_beta_tester_to_groups POSTs a betaGroups array to the relationship endpoint", async () => {
  const { client, calls } = fakeClient({});
  await addBetaTesterToGroupsTool.handler(parse(addBetaTesterToGroupsTool, { betaTesterId: "t1", groupIds: ["bg1"] }), { client, config: cfg });
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/betaTesters/t1/relationships/betaGroups");
  assert.deepEqual((post.body as any).data, [{ type: "betaGroups", id: "bg1" }]);
});

test("asc_remove_beta_tester_from_groups DELETEs with a betaGroups body", async () => {
  const { client, calls } = fakeClient({});
  await removeBetaTesterFromGroupsTool.handler(parse(removeBetaTesterFromGroupsTool, { betaTesterId: "t1", groupIds: ["bg1"] }), { client, config: cfg });
  const del = calls.find((c) => c.method === "DELETE")!;
  assert.equal(del.path, "/v1/betaTesters/t1/relationships/betaGroups");
  assert.deepEqual((del.body as any).data, [{ type: "betaGroups", id: "bg1" }]);
});

test("asc_add_beta_tester_to_builds POSTs a builds array to the relationship endpoint", async () => {
  const { client, calls } = fakeClient({});
  await addBetaTesterToBuildsTool.handler(parse(addBetaTesterToBuildsTool, { betaTesterId: "t1", buildIds: ["b1"] }), { client, config: cfg });
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/betaTesters/t1/relationships/builds");
  assert.deepEqual((post.body as any).data, [{ type: "builds", id: "b1" }]);
});

test("asc_remove_beta_tester_from_builds DELETEs with a builds body", async () => {
  const { client, calls } = fakeClient({});
  await removeBetaTesterFromBuildsTool.handler(parse(removeBetaTesterFromBuildsTool, { betaTesterId: "t1", buildIds: ["b1"] }), { client, config: cfg });
  const del = calls.find((c) => c.method === "DELETE")!;
  assert.equal(del.path, "/v1/betaTesters/t1/relationships/builds");
  assert.deepEqual((del.body as any).data, [{ type: "builds", id: "b1" }]);
});

test("asc_remove_beta_tester_from_app DELETEs with a single app id wrapped in an array", async () => {
  const { client, calls } = fakeClient({});
  await removeBetaTesterFromAppTool.handler(parse(removeBetaTesterFromAppTool, { betaTesterId: "t1", appId: "app1" }), { client, config: cfg });
  const del = calls.find((c) => c.method === "DELETE")!;
  assert.equal(del.path, "/v1/betaTesters/t1/relationships/apps");
  assert.deepEqual((del.body as any).data, [{ type: "apps", id: "app1" }]);
});
