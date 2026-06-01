import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createWebhookTool, pingWebhookTool } from "../src/tools/webhooks.ts";
import { inviteUserTool, updateUserTool } from "../src/tools/users.ts";
import { startCiBuildTool, listCiWorkflowsTool } from "../src/tools/xcode_cloud.ts";
import { getSalesReportTool } from "../src/tools/reports.ts";
import { createAchievementTool, createLeaderboardTool } from "../src/tools/gamecenter.ts";
import { createMarketplaceDomainTool, createAltDistributionKeyTool } from "../src/tools/alt_distribution.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

// Handler tests for the extended domains, against a recording stub client (AscClient itself is
// covered in client.test.ts). Tight coverage of the non-obvious payloads + the reports gunzip path.

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  get?: (path: string) => unknown;
  getRaw?: (path: string) => Buffer;
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async get(path: string) { calls.push({ method: "GET", path }); return responses.get?.(path); },
    async getRaw(path: string) { calls.push({ method: "GETRAW", path }); return responses.getRaw?.(path) ?? Buffer.from(""); },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new" } }; },
    async patch(path: string, body: unknown) { calls.push({ method: "PATCH", path, body }); return responses.patch?.(path, body) ?? { data: { id: "patched" } }; },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_create_webhook posts url/eventTypes + app relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "wh1" } }) });
  await createWebhookTool.handler(parse(createWebhookTool, { appId: "app1", name: "CI", url: "https://x.test/hook", eventTypes: ["BUILD_PROCESSING_COMPLETED"] }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "webhooks");
  assert.equal(body.data.attributes.url, "https://x.test/hook");
  assert.deepEqual(body.data.attributes.eventTypes, ["BUILD_PROCESSING_COMPLETED"]);
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
});

test("asc_ping_webhook posts a webhookPings with the webhook relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "p1" } }) });
  await pingWebhookTool.handler(parse(pingWebhookTool, { webhookId: "wh1" }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "webhookPings");
  assert.deepEqual(body.data.relationships.webhook.data, { type: "webhooks", id: "wh1" });
});

test("asc_invite_user posts email/roles + scoped visibleApps", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "inv1" } }) });
  await inviteUserTool.handler(parse(inviteUserTool, {
    email: "dev@x.test", firstName: "D", lastName: "E", roles: ["DEVELOPER"], allAppsVisible: false, visibleAppIds: ["app1", "app2"],
  }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "userInvitations");
  assert.deepEqual(body.data.attributes.roles, ["DEVELOPER"]);
  assert.equal(body.data.attributes.allAppsVisible, false);
  assert.equal(body.data.relationships.visibleApps.data.length, 2);
});

test("asc_update_user only sends provided fields", async () => {
  const { client, calls } = fakeClient({ patch: () => ({ data: { id: "u1" } }) });
  await updateUserTool.handler(parse(updateUserTool, { userId: "u1", roles: ["APP_MANAGER"] }), { client, config: cfg });
  const body = calls.find((c) => c.method === "PATCH")!.body as any;
  assert.deepEqual(body.data.attributes.roles, ["APP_MANAGER"]);
  assert.equal("allAppsVisible" in body.data.attributes, false);
});

test("asc_start_ci_build posts workflow (+ git ref when given)", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "run1" } }) });
  await startCiBuildTool.handler(parse(startCiBuildTool, { workflowId: "wf1", sourceBranchOrTagId: "ref1" }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "ciBuildRuns");
  assert.deepEqual(body.data.relationships.workflow.data, { type: "ciWorkflows", id: "wf1" });
  assert.deepEqual(body.data.relationships.sourceBranchOrTag.data, { type: "scmGitReferences", id: "ref1" });
});

test("asc_list_ci_workflows hits the product's workflows", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "wf1", attributes: { name: "Release" } }] });
  await listCiWorkflowsTool.handler(parse(listCiWorkflowsTool, { ciProductId: "prod1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/ciProducts/prod1/workflows");
});

test("asc_get_sales_report gunzips + parses the TSV", async () => {
  const tsv = "Provider\tUnits\tDeveloper Proceeds\nAPPLE\t10\t6.93\nAPPLE\t5\t3.50";
  const { client, calls } = fakeClient({ getRaw: () => gzipSync(Buffer.from(tsv, "utf8")) });
  const out = await getSalesReportTool.handler(
    parse(getSalesReportTool, { vendorNumber: "80000000", reportDate: "2026-06-01" }),
    { client, config: cfg },
  ) as { columns: string[]; rowCount: number; rows: Record<string, string>[] };
  assert.equal(calls.find((c) => c.method === "GETRAW")!.path, "/v1/salesReports");
  assert.deepEqual(out.columns, ["Provider", "Units", "Developer Proceeds"]);
  assert.equal(out.rowCount, 2);
  assert.equal(out.rows[0]!.Units, "10");
});

test("asc_create_achievement / asc_create_leaderboard post under the gameCenterDetail", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "x" } }) });
  await createAchievementTool.handler(parse(createAchievementTool, { gameCenterDetailId: "gc1", referenceName: "First Win", vendorIdentifier: "first_win", points: 10 }), { client, config: cfg });
  await createLeaderboardTool.handler(parse(createLeaderboardTool, { gameCenterDetailId: "gc1", referenceName: "High Scores", vendorIdentifier: "high_scores" }), { client, config: cfg });
  const bodies = calls.filter((c) => c.method === "POST").map((c) => c.body as any);
  assert.deepEqual(bodies[0].data.relationships.gameCenterDetail.data, { type: "gameCenterDetails", id: "gc1" });
  assert.equal(bodies[0].data.attributes.points, 10);
  assert.equal(bodies[1].data.type, "gameCenterLeaderboards");
  assert.equal(bodies[1].data.attributes.submissionType, "BEST_SCORE");
});

test("alt distribution: create key + marketplace domain post the right shapes", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "x" } }) });
  await createAltDistributionKeyTool.handler(parse(createAltDistributionKeyTool, { appId: "app1", publicKey: "-----BEGIN PUBLIC KEY-----" }), { client, config: cfg });
  await createMarketplaceDomainTool.handler(parse(createMarketplaceDomainTool, { domain: "apps.example.eu" }), { client, config: cfg });
  const bodies = calls.filter((c) => c.method === "POST").map((c) => c.body as any);
  assert.deepEqual(bodies[0].data.relationships.app.data, { type: "apps", id: "app1" });
  assert.equal(bodies[1].data.type, "marketplaceDomains");
  assert.equal(bodies[1].data.attributes.domain, "apps.example.eu");
});
