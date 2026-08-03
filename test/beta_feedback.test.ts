import test from "node:test";
import assert from "node:assert/strict";
import {
  listBetaFeedbackCrashesTool, getBetaFeedbackCrashTool, getBetaFeedbackCrashLogTool,
  getBetaCrashLogByIdTool, deleteBetaFeedbackCrashTool, listBetaFeedbackScreenshotsTool,
  getBetaFeedbackScreenshotTool, deleteBetaFeedbackScreenshotTool,
} from "../src/tools/beta_feedback.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

// Recording stub client. delete records opts?.body so DELETE-with-body tools (none in this file, but
// the convention is shared) can be asserted; here the deletes are plain.
interface Call { method: string; path: string; body?: unknown; query?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  get?: (path: string) => unknown;
  getOne?: (path: string) => unknown;
  del?: (path: string) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string, query?: unknown) { calls.push({ method: "LIST", path, query }); return responses.list?.(path) ?? []; },
    async get(path: string, opts?: { query?: unknown }) { calls.push({ method: "GET", path, query: opts?.query }); return responses.get?.(path); },
    async getOne(path: string) { calls.push({ method: "GETONE", path }); return responses.getOne?.(path) ?? { id: "", type: "", attributes: {} }; },
    async delete(path: string, opts?: { body?: unknown }) { calls.push({ method: "DELETE", path, body: opts?.body }); return responses.del?.(path); },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_list_beta_feedback_crashes hits the app-scoped path, maps rows, strips PII by default", async () => {
  const { client, calls } = fakeClient({
    list: () => [{ id: "c1", attributes: { deviceModel: "iPhone14,2", email: "tester@x.test", comment: "it crashed" } }],
  });
  const out = await listBetaFeedbackCrashesTool.handler(
    parse(listBetaFeedbackCrashesTool, { appId: "app1" }),
    { client, config: cfg },
  ) as Array<Record<string, unknown>>;
  const list = calls.find((c) => c.method === "LIST")!;
  assert.equal(list.path, "/v1/apps/app1/betaFeedbackCrashSubmissions");
  assert.equal((list.query as any).sort, "-createdDate");
  assert.equal(out[0]!.id, "c1");
  assert.equal(out[0]!.deviceModel, "iPhone14,2");
  assert.equal("email" in out[0]!, false);
  assert.equal("comment" in out[0]!, false);
});

test("asc_list_beta_feedback_crashes maps all filters to exact filter[...] keys + include", async () => {
  const { client, calls } = fakeClient({ list: () => [] });
  await listBetaFeedbackCrashesTool.handler(parse(listBetaFeedbackCrashesTool, {
    appId: "app1", buildId: "b1", preReleaseVersionId: "pre1", testerId: "t1",
    deviceModel: "iPhone14,2", osVersion: "17.4", appPlatform: "IOS", devicePlatform: "IOS",
    sort: "createdDate", includeRelated: true, limit: 50,
  }), { client, config: cfg });
  const q = calls.find((c) => c.method === "LIST")!.query as any;
  assert.equal(q["filter[build]"], "b1");
  assert.equal(q["filter[build.preReleaseVersion]"], "pre1");
  assert.equal(q["filter[tester]"], "t1");
  assert.equal(q["filter[deviceModel]"], "iPhone14,2");
  assert.equal(q["filter[osVersion]"], "17.4");
  assert.equal(q["filter[appPlatform]"], "IOS");
  assert.equal(q["filter[devicePlatform]"], "IOS");
  assert.equal(q.sort, "createdDate");
  assert.equal(q.limit, 50);
  assert.equal(q.include, "build,tester");
});

test("asc_list_beta_feedback_crashes keeps PII when includePii=true", async () => {
  const { client } = fakeClient({
    list: () => [{ id: "c1", attributes: { email: "tester@x.test", comment: "hi" } }],
  });
  const out = await listBetaFeedbackCrashesTool.handler(
    parse(listBetaFeedbackCrashesTool, { appId: "app1", includePii: true }),
    { client, config: cfg },
  ) as Array<Record<string, unknown>>;
  assert.equal(out[0]!.email, "tester@x.test");
  assert.equal(out[0]!.comment, "hi");
});

test("asc_get_beta_feedback_crash keeps PII by default and returns the raw envelope", async () => {
  const { client, calls } = fakeClient({
    get: () => ({ data: { id: "c1", type: "betaFeedbackCrashSubmissions", attributes: { email: "tester@x.test", comment: "hi" } } }),
  });
  const out = await getBetaFeedbackCrashTool.handler(
    parse(getBetaFeedbackCrashTool, { submissionId: "c1" }),
    { client, config: cfg },
  ) as { data: { attributes: Record<string, unknown> } };
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/betaFeedbackCrashSubmissions/c1");
  assert.equal(out.data.attributes.email, "tester@x.test");
  assert.equal(out.data.attributes.comment, "hi");
});

test("asc_get_beta_feedback_crash strips PII when includePii=false and sideloads when includeRelated=true", async () => {
  const { client, calls } = fakeClient({
    get: () => ({ data: { id: "c1", attributes: { deviceModel: "iPhone14,2", email: "tester@x.test", comment: "hi" } } }),
  });
  const out = await getBetaFeedbackCrashTool.handler(
    parse(getBetaFeedbackCrashTool, { submissionId: "c1", includePii: false, includeRelated: true }),
    { client, config: cfg },
  ) as { data: { attributes: Record<string, unknown> } };
  assert.equal((calls.find((c) => c.method === "GET")!.query as any).include, "build,tester");
  assert.equal(out.data.attributes.deviceModel, "iPhone14,2");
  assert.equal("email" in out.data.attributes, false);
  assert.equal("comment" in out.data.attributes, false);
});

test("asc_get_beta_feedback_crash_log reads the crashLog resource, truncates, and reports counts", async () => {
  const full = "x".repeat(120);
  const { client, calls } = fakeClient({
    getOne: () => ({ id: "crash-log-1", type: "betaCrashLogs", attributes: { logText: full } }),
  });
  const out = await getBetaFeedbackCrashLogTool.handler(
    parse(getBetaFeedbackCrashLogTool, { submissionId: "c1", maxLogChars: 50 }),
    { client, config: cfg },
  ) as { totalCharacters: number; returnedCharacters: number; truncated: boolean; logText: string };
  assert.equal(calls.find((c) => c.method === "GETONE")!.path, "/v1/betaFeedbackCrashSubmissions/c1/crashLog");
  assert.equal(out.totalCharacters, 120);
  assert.equal(out.returnedCharacters, 50);
  assert.equal(out.truncated, true);
  assert.equal(out.logText.length, 50);
});

test("asc_get_beta_feedback_crash_log returns the full log untruncated when under the limit", async () => {
  const { client } = fakeClient({
    getOne: () => ({ id: "crash-log-1", type: "betaCrashLogs", attributes: { logText: "plain crash text" } }),
  });
  const out = await getBetaFeedbackCrashLogTool.handler(
    parse(getBetaFeedbackCrashLogTool, { submissionId: "c1" }),
    { client, config: cfg },
  ) as { totalCharacters: number; truncated: boolean; logText: string };
  assert.equal(out.logText, "plain crash text");
  assert.equal(out.truncated, false);
  assert.equal(out.totalCharacters, "plain crash text".length);
});

test("asc_get_beta_crash_log_by_id reads /v1/betaCrashLogs/:id", async () => {
  const { client, calls } = fakeClient({
    getOne: () => ({ id: "log1", type: "betaCrashLogs", attributes: { logText: "log" } }),
  });
  const out = await getBetaCrashLogByIdTool.handler(
    parse(getBetaCrashLogByIdTool, { crashLogId: "log1" }),
    { client, config: cfg },
  ) as { logText: string; truncated: boolean };
  assert.equal(calls.find((c) => c.method === "GETONE")!.path, "/v1/betaCrashLogs/log1");
  assert.equal(out.logText, "log");
  assert.equal(out.truncated, false);
});

test("asc_delete_beta_feedback_crash deletes and returns ok", async () => {
  const { client, calls } = fakeClient({});
  const out = await deleteBetaFeedbackCrashTool.handler(
    parse(deleteBetaFeedbackCrashTool, { submissionId: "c1" }),
    { client, config: cfg },
  ) as { ok: boolean; submissionId: string };
  assert.equal(calls.find((c) => c.method === "DELETE")!.path, "/v1/betaFeedbackCrashSubmissions/c1");
  assert.deepEqual(out, { ok: true, submissionId: "c1" });
});

test("asc_list_beta_feedback_screenshots hits the screenshot path and strips PII by default", async () => {
  const { client, calls } = fakeClient({
    list: () => [{ id: "s1", attributes: { screenshots: [{ url: "https://x/1.png" }], email: "t@x.test", comment: "ui bug" } }],
  });
  const out = await listBetaFeedbackScreenshotsTool.handler(
    parse(listBetaFeedbackScreenshotsTool, { appId: "app1" }),
    { client, config: cfg },
  ) as Array<Record<string, unknown>>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/apps/app1/betaFeedbackScreenshotSubmissions");
  assert.deepEqual(out[0]!.screenshots, [{ url: "https://x/1.png" }]);
  assert.equal("email" in out[0]!, false);
  assert.equal("comment" in out[0]!, false);
});

test("asc_get_beta_feedback_screenshot keeps PII by default", async () => {
  const { client, calls } = fakeClient({
    get: () => ({ data: { id: "s1", attributes: { email: "t@x.test", comment: "ui bug" } } }),
  });
  const out = await getBetaFeedbackScreenshotTool.handler(
    parse(getBetaFeedbackScreenshotTool, { submissionId: "s1" }),
    { client, config: cfg },
  ) as { data: { attributes: Record<string, unknown> } };
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/betaFeedbackScreenshotSubmissions/s1");
  assert.equal(out.data.attributes.email, "t@x.test");
  assert.equal(out.data.attributes.comment, "ui bug");
});

test("asc_delete_beta_feedback_screenshot deletes and returns ok", async () => {
  const { client, calls } = fakeClient({});
  const out = await deleteBetaFeedbackScreenshotTool.handler(
    parse(deleteBetaFeedbackScreenshotTool, { submissionId: "s1" }),
    { client, config: cfg },
  ) as { ok: boolean; submissionId: string };
  assert.equal(calls.find((c) => c.method === "DELETE")!.path, "/v1/betaFeedbackScreenshotSubmissions/s1");
  assert.deepEqual(out, { ok: true, submissionId: "s1" });
});
