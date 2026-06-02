import test from "node:test";
import assert from "node:assert/strict";
import {
  listExperimentsTool, createExperimentTool, getExperimentTool, updateExperimentTool,
  createExperimentTreatmentTool, setExperimentTreatmentLocalizationTool,
  deleteExperimentTreatmentTool, deleteExperimentTool,
} from "../src/tools/experiments.ts";
import { findOrCreateScreenshotSetTool } from "../src/tools/screenshots.ts";
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

test("asc_create_experiment posts to the v2 endpoint with traffic + app relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "exp1", attributes: { name: "Icons", state: "PREPARE_FOR_SUBMISSION" } } }) });
  const out = await createExperimentTool.handler(
    parse(createExperimentTool, { appId: "app1", name: "Icons", trafficProportion: 50 }),
    { client, config: cfg },
  ) as { experimentId: string };
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v2/appStoreVersionExperiments");
  const body = post.body as any;
  assert.equal(body.data.type, "appStoreVersionExperiments");
  assert.equal(body.data.attributes.trafficProportion, 50);
  assert.equal(body.data.attributes.platform, "IOS");
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
  assert.equal(out.experimentId, "exp1");
});

test("asc_update_experiment launches via started=true and rejects an empty update", async () => {
  const { client, calls } = fakeClient({});
  await updateExperimentTool.handler(parse(updateExperimentTool, { experimentId: "exp1", started: true }), { client, config: cfg });
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v2/appStoreVersionExperiments/exp1");
  assert.equal((patch.body as any).data.attributes.started, true);
  await assert.rejects(() => updateExperimentTool.handler(parse(updateExperimentTool, { experimentId: "exp1" }), { client, config: cfg }), /at least one field/);
});

test("asc_create_experiment_treatment references the v2 experiment parent", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "tr1", attributes: { name: "Treatment A" } } }) });
  await createExperimentTreatmentTool.handler(
    parse(createExperimentTreatmentTool, { experimentId: "exp1", name: "Treatment A", appIconName: "alt-icon" }),
    { client, config: cfg },
  );
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "appStoreVersionExperimentTreatments");
  assert.equal(body.data.attributes.appIconName, "alt-icon");
  assert.deepEqual(body.data.relationships.appStoreVersionExperimentV2.data, { type: "appStoreVersionExperiments", id: "exp1" });
});

test("asc_set_experiment_treatment_localization is find-or-create", async () => {
  let existing: unknown[] = [];
  const { client, calls } = fakeClient({ list: () => existing, post: () => ({ data: { id: "tloc1" } }) });
  const created = await setExperimentTreatmentLocalizationTool.handler(
    parse(setExperimentTreatmentLocalizationTool, { treatmentId: "tr1", locale: "en-US" }),
    { client, config: cfg },
  ) as { id: string; action: string };
  assert.equal(created.action, "created");
  assert.equal(created.id, "tloc1");
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.deepEqual(body.data.relationships.appStoreVersionExperimentTreatment.data, { type: "appStoreVersionExperimentTreatments", id: "tr1" });

  existing = [{ id: "tloc1", attributes: { locale: "en-US" } }];
  const found = await setExperimentTreatmentLocalizationTool.handler(
    parse(setExperimentTreatmentLocalizationTool, { treatmentId: "tr1", locale: "en-US" }),
    { client, config: cfg },
  ) as { action: string };
  assert.equal(found.action, "found");
});

test("asc_get_experiment assembles experiment + treatments", async () => {
  const { client, calls } = fakeClient({
    getOne: () => ({ id: "exp1", attributes: { name: "Icons", state: "ACCEPTED", trafficProportion: 50 } }),
    list: () => [{ id: "tr1", attributes: { name: "Treatment A" } }],
  });
  const out = await getExperimentTool.handler(parse(getExperimentTool, { experimentId: "exp1" }), { client, config: cfg }) as { treatments: Array<{ id: string }> };
  assert.equal(calls.find((c) => c.method === "GETONE")!.path, "/v2/appStoreVersionExperiments/exp1");
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v2/appStoreVersionExperiments/exp1/appStoreVersionExperimentTreatments");
  assert.equal(out.treatments[0]!.id, "tr1");
});

test("screenshot set targets an experiment treatment localization", async () => {
  const { client, calls } = fakeClient({ list: () => [], post: () => ({ data: { id: "set1" } }) });
  await findOrCreateScreenshotSetTool.handler(
    parse(findOrCreateScreenshotSetTool, { experimentTreatmentLocalizationId: "tloc1", displayType: "APP_IPHONE_67" }),
    { client, config: cfg },
  );
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/appStoreVersionExperimentTreatmentLocalizations/tloc1/appScreenshotSets");
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.deepEqual(body.data.relationships.appStoreVersionExperimentTreatmentLocalization.data, { type: "appStoreVersionExperimentTreatmentLocalizations", id: "tloc1" });
  // exactly-one-parent guard still holds across all three parent kinds
  assert.throws(() => parse(findOrCreateScreenshotSetTool, { localizationId: "l1", experimentTreatmentLocalizationId: "t1", displayType: "APP_IPHONE_67" }));
});

test("asc_list / asc_delete experiment + treatment hit the right paths", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "exp1", attributes: { name: "Icons", state: "STOPPED" } }] });
  await listExperimentsTool.handler(parse(listExperimentsTool, { appId: "app1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/apps/app1/appStoreVersionExperimentsV2");
  await deleteExperimentTreatmentTool.handler(parse(deleteExperimentTreatmentTool, { treatmentId: "tr1" }), { client, config: cfg });
  await deleteExperimentTool.handler(parse(deleteExperimentTool, { experimentId: "exp1" }), { client, config: cfg });
  const dels = calls.filter((c) => c.method === "DELETE").map((c) => c.path);
  assert.ok(dels.includes("/v1/appStoreVersionExperimentTreatments/tr1"));
  assert.ok(dels.includes("/v2/appStoreVersionExperiments/exp1"));
});
