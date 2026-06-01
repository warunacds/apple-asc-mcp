import test from "node:test";
import assert from "node:assert/strict";
import { setContentRightsTool, getAgeRatingTool, setAgeRatingTool } from "../src/tools/compliance.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

// Handler tests against a recording stub client (the AscClient is covered in client.test.ts).
// Focus: the content-rights enum mapping, appInfo→declaration resolution, and that set_age_rating
// PATCHes only the fields passed (plus the additionalDeclarations escape hatch).

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  get?: (path: string) => unknown;
  patch?: (path: string, body: unknown) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async get(path: string) { calls.push({ method: "GET", path }); return responses.get?.(path); },
    async patch(path: string, body: unknown) { calls.push({ method: "PATCH", path, body }); return responses.patch?.(path, body) ?? { data: { id: "patched" } }; },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_set_content_rights maps true → USES_THIRD_PARTY_CONTENT and PATCHes the app", async () => {
  const { client, calls } = fakeClient({ patch: () => ({ data: { id: "app1" } }) });
  const out = await setContentRightsTool.handler(
    parse(setContentRightsTool, { appId: "app1", usesThirdPartyContent: true }),
    { client, config: cfg },
  ) as { contentRightsDeclaration: string };
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v1/apps/app1");
  assert.equal((patch.body as any).data.type, "apps");
  assert.equal((patch.body as any).data.attributes.contentRightsDeclaration, "USES_THIRD_PARTY_CONTENT");
  assert.equal(out.contentRightsDeclaration, "USES_THIRD_PARTY_CONTENT");
});

test("asc_set_content_rights maps false → DOES_NOT_USE_THIRD_PARTY_CONTENT", async () => {
  const { client, calls } = fakeClient({ patch: () => ({ data: { id: "app1" } }) });
  await setContentRightsTool.handler(parse(setContentRightsTool, { appId: "app1", usesThirdPartyContent: false }), { client, config: cfg });
  assert.equal((calls.find((c) => c.method === "PATCH")!.body as any).data.attributes.contentRightsDeclaration, "DOES_NOT_USE_THIRD_PARTY_CONTENT");
});

test("asc_get_age_rating resolves the editable AppInfo then reads its declaration", async () => {
  const { client, calls } = fakeClient({
    list: () => [
      { id: "info_prep", attributes: { state: "PREPARE_FOR_SUBMISSION" } },
      { id: "info_live", attributes: { state: "READY_FOR_DISTRIBUTION" } },
    ],
    get: () => ({ data: { id: "decl1", attributes: { violenceCartoonOrFantasy: "NONE" } } }),
  });
  const out = await getAgeRatingTool.handler(parse(getAgeRatingTool, { appId: "app1" }), { client, config: cfg }) as { id: string; appInfoId: string };
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/apps/app1/appInfos");
  assert.equal(out.appInfoId, "info_prep"); // picked the PREPARE one, not the live one
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/appInfos/info_prep/ageRatingDeclaration");
  assert.equal(out.id, "decl1");
});

test("asc_set_age_rating PATCHes only provided fields + additionalDeclarations, skips lookup with appInfoId", async () => {
  const { client, calls } = fakeClient({
    get: () => ({ data: { id: "decl1" } }),
    patch: () => ({ data: { id: "decl1" } }),
  });
  await setAgeRatingTool.handler(parse(setAgeRatingTool, {
    appId: "app1",
    appInfoId: "info1",
    violenceCartoonOrFantasy: "INFREQUENT_OR_MILD",
    gambling: true,
    additionalDeclarations: { someNewQuestion2025: "FREQUENT_OR_INTENSE" },
  }), { client, config: cfg });
  assert.equal(calls.some((c) => c.method === "LIST"), false, "appInfoId given → no AppInfo lookup");
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/appInfos/info1/ageRatingDeclaration");
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v1/ageRatingDeclarations/decl1");
  const attrs = (patch.body as any).data.attributes;
  assert.equal(attrs.violenceCartoonOrFantasy, "INFREQUENT_OR_MILD");
  assert.equal(attrs.gambling, true);
  assert.equal(attrs.someNewQuestion2025, "FREQUENT_OR_INTENSE"); // escape hatch merged in
  assert.equal("violenceRealistic" in attrs, false, "untouched fields are not sent");
});

test("asc_set_age_rating errors when no questionnaire fields are provided", async () => {
  const { client } = fakeClient({ get: () => ({ data: { id: "decl1" } }) });
  await assert.rejects(
    () => setAgeRatingTool.handler(parse(setAgeRatingTool, { appId: "app1", appInfoId: "info1" }), { client, config: cfg }),
    /No age-rating fields/,
  );
});
