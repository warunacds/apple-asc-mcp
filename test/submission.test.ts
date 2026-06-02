import test from "node:test";
import assert from "node:assert/strict";
import {
  getAppAvailabilityTool, setAppAvailabilityTool, listEncryptionDeclarationsTool,
  createEncryptionDeclarationTool, assignEncryptionDeclarationTool,
} from "../src/tools/submission.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

// Handler tests against a recording stub client (the AscClient is covered in client.test.ts).
// Focus: availability payload (explicit + all-territories), encryption-declaration create/assign shapes.

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

test("asc_get_app_availability reads the appAvailabilityV2 singleton", async () => {
  const { client, calls } = fakeClient({ get: () => ({ data: { id: "avail1" } }) });
  await getAppAvailabilityTool.handler(parse(getAppAvailabilityTool, { appId: "app1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/apps/app1/appAvailabilityV2");
});

test("asc_set_app_availability posts explicit territories", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "avail1" } }) });
  await setAppAvailabilityTool.handler(parse(setAppAvailabilityTool, { appId: "app1", territories: ["USA", "GBR"] }), { client, config: cfg });
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v2/appAvailabilities");
  const body = post.body as any;
  assert.equal(body.data.type, "appAvailabilities");
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
  assert.equal(body.data.relationships.territoryAvailabilities.data.length, 2);
  // The v2 shape references inline `territoryAvailabilities` resources (NOT plain territory refs);
  // each is created in `included` with its own territory relationship + available flag.
  assert.equal(body.data.relationships.territoryAvailabilities.data[0].type, "territoryAvailabilities");
  assert.equal(body.included.length, 2);
  assert.equal(body.included[0].type, "territoryAvailabilities");
  assert.equal(body.included[0].id, body.data.relationships.territoryAvailabilities.data[0].id);
  assert.deepEqual(body.included[0].relationships.territory.data, { type: "territories", id: "USA" });
  assert.equal(body.included[0].attributes.available, true);
  assert.equal(body.data.attributes.availableInNewTerritories, true);
});

test("asc_set_app_availability expands availableInAllTerritories via /v1/territories", async () => {
  const { client, calls } = fakeClient({
    list: (path) => path === "/v1/territories" ? [{ id: "USA" }, { id: "GBR" }, { id: "JPN" }] : [],
    post: () => ({ data: { id: "avail1" } }),
  });
  await setAppAvailabilityTool.handler(parse(setAppAvailabilityTool, { appId: "app1", availableInAllTerritories: true, availableInNewTerritories: false }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/territories");
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.relationships.territoryAvailabilities.data.length, 3);
  assert.equal(body.data.attributes.availableInNewTerritories, false);
});

test("asc_list_encryption_declarations filters by app", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "decl1", attributes: { usesEncryption: true } }] });
  const out = await listEncryptionDeclarationsTool.handler(parse(listEncryptionDeclarationsTool, { appId: "app1" }), { client, config: cfg }) as Array<{ id: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/appEncryptionDeclarations");
  assert.equal(out[0]!.id, "decl1");
});

test("asc_create_encryption_declaration posts appDescription + crypto flags + app relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "decl1", attributes: {} } }) });
  await createEncryptionDeclarationTool.handler(
    parse(createEncryptionDeclarationTool, {
      appId: "app1", appDescription: "Standard HTTPS only",
      containsProprietaryCryptography: false, containsThirdPartyCryptography: false, availableOnFrenchStore: true,
    }),
    { client, config: cfg },
  );
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "appEncryptionDeclarations");
  assert.equal(body.data.attributes.appDescription, "Standard HTTPS only");
  assert.equal(body.data.attributes.containsProprietaryCryptography, false);
  assert.equal(body.data.attributes.containsThirdPartyCryptography, false);
  assert.equal(body.data.attributes.availableOnFrenchStore, true);
  assert.equal("usesEncryption" in body.data.attributes, false, "the spec has no usesEncryption attr");
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
});

test("asc_create_encryption_declaration requires the crypto flags + description", () => {
  assert.throws(() => parse(createEncryptionDeclarationTool, { appId: "app1", availableOnFrenchStore: true }));
});

test("asc_assign_encryption_declaration PATCHes the build relationship", async () => {
  const { client, calls } = fakeClient({ patch: () => ({}) });
  await assignEncryptionDeclarationTool.handler(parse(assignEncryptionDeclarationTool, { buildId: "b1", declarationId: "decl1" }), { client, config: cfg });
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v1/builds/b1/relationships/appEncryptionDeclaration");
  assert.deepEqual((patch.body as any).data, { type: "appEncryptionDeclarations", id: "decl1" });
});
