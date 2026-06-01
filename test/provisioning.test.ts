import test from "node:test";
import assert from "node:assert/strict";
import {
  listBundleIdsTool, createBundleIdTool, deleteBundleIdTool, enableBundleCapabilityTool,
  createCertificateTool, registerDeviceTool, createProfileTool, deleteProfileTool,
} from "../src/tools/provisioning.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  post?: (path: string, body: unknown) => unknown;
  del?: (path: string) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new" } }; },
    async delete(path: string) { calls.push({ method: "DELETE", path }); return responses.del?.(path); },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_create_bundle_id posts name/identifier/platform", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "bid1", attributes: { identifier: "com.x.app" } } }) });
  const out = await createBundleIdTool.handler(parse(createBundleIdTool, { name: "My App", identifier: "com.x.app", platform: "UNIVERSAL" }), { client, config: cfg }) as { bundleIdResourceId: string };
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "bundleIds");
  assert.equal(body.data.attributes.identifier, "com.x.app");
  assert.equal(body.data.attributes.platform, "UNIVERSAL");
  assert.equal(out.bundleIdResourceId, "bid1");
});

test("asc_list_bundle_ids filters by identifier", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "bid1", attributes: { identifier: "com.x.app" } }] });
  await listBundleIdsTool.handler(parse(listBundleIdsTool, { identifier: "com.x.app" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/bundleIds");
});

test("asc_enable_bundle_capability posts capabilityType + bundleId relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "cap1" } }) });
  await enableBundleCapabilityTool.handler(parse(enableBundleCapabilityTool, { bundleIdResourceId: "bid1", capabilityType: "PUSH_NOTIFICATIONS" }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "bundleIdCapabilities");
  assert.equal(body.data.attributes.capabilityType, "PUSH_NOTIFICATIONS");
  assert.deepEqual(body.data.relationships.bundleId.data, { type: "bundleIds", id: "bid1" });
});

test("asc_create_certificate posts certificateType + csrContent", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "cert1", attributes: { certificateContent: "BASE64" } } }) });
  await createCertificateTool.handler(parse(createCertificateTool, { certificateType: "DISTRIBUTION", csrContent: "-----BEGIN CERTIFICATE REQUEST-----" }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "certificates");
  assert.equal(body.data.attributes.certificateType, "DISTRIBUTION");
  assert.ok(body.data.attributes.csrContent.startsWith("-----BEGIN"));
});

test("asc_register_device posts name/udid/platform", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "dev1" } }) });
  await registerDeviceTool.handler(parse(registerDeviceTool, { name: "My iPhone", udid: "00008110-ABCDEF", platform: "IOS" }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "devices");
  assert.equal(body.data.attributes.udid, "00008110-ABCDEF");
});

test("asc_create_profile links bundleId + certificates, and devices when given", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "prof1", attributes: { uuid: "U" } } }) });
  await createProfileTool.handler(parse(createProfileTool, {
    name: "AdHoc", profileType: "IOS_APP_ADHOC", bundleIdResourceId: "bid1", certificateIds: ["cert1"], deviceIds: ["dev1", "dev2"],
  }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "profiles");
  assert.equal(body.data.attributes.profileType, "IOS_APP_ADHOC");
  assert.deepEqual(body.data.relationships.bundleId.data, { type: "bundleIds", id: "bid1" });
  assert.equal(body.data.relationships.certificates.data.length, 1);
  assert.equal(body.data.relationships.devices.data.length, 2);
});

test("asc_create_profile omits devices for App Store profiles", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "prof2" } }) });
  await createProfileTool.handler(parse(createProfileTool, {
    name: "Store", profileType: "IOS_APP_STORE", bundleIdResourceId: "bid1", certificateIds: ["cert1"],
  }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.relationships.devices, undefined);
});

test("asc_delete_bundle_id / asc_delete_profile DELETE the right paths", async () => {
  const { client, calls } = fakeClient({});
  await deleteBundleIdTool.handler(parse(deleteBundleIdTool, { bundleIdResourceId: "bid1" }), { client, config: cfg });
  await deleteProfileTool.handler(parse(deleteProfileTool, { profileId: "prof1" }), { client, config: cfg });
  const paths = calls.filter((c) => c.method === "DELETE").map((c) => c.path);
  assert.ok(paths.includes("/v1/bundleIds/bid1"));
  assert.ok(paths.includes("/v1/profiles/prof1"));
});
