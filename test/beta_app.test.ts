import test from "node:test";
import assert from "node:assert/strict";
import {
  listBetaAppLocalizationsTool, createBetaAppLocalizationTool, getBetaAppLocalizationTool,
  updateBetaAppLocalizationTool, deleteBetaAppLocalizationTool,
  listBetaAppReviewSubmissionsTool, getBetaAppReviewSubmissionTool,
  getBetaAppReviewDetailsTool, updateBetaAppReviewDetailsTool,
  listBetaLicenseAgreementsTool, getBetaLicenseAgreementTool, updateBetaLicenseAgreementTool,
} from "../src/tools/beta_app.ts";
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
    async delete(path: string) { calls.push({ method: "DELETE", path }); return responses.del?.(path); },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

// ── Beta app localizations ────────────────────────────────────────────────────

test("asc_list_beta_app_localizations lists app-scoped localizations", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "loc1", attributes: { locale: "en-US", description: "Try it" } }] });
  const out = await listBetaAppLocalizationsTool.handler(parse(listBetaAppLocalizationsTool, { appId: "app1" }), { client, config: cfg }) as Array<{ id: string; locale?: string }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/apps/app1/betaAppLocalizations");
  assert.equal(out[0]!.id, "loc1");
  assert.equal(out[0]!.locale, "en-US");
});

test("asc_create_beta_app_localization posts locale + optional fields + app relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "loc1", attributes: { locale: "ja" } } }) });
  await createBetaAppLocalizationTool.handler(parse(createBetaAppLocalizationTool, {
    appId: "app1", locale: "ja", description: "テスト", feedbackEmail: "qa@example.com",
  }), { client, config: cfg });
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.path, "/v1/betaAppLocalizations");
  const body = post.body as any;
  assert.equal(body.data.type, "betaAppLocalizations");
  assert.equal(body.data.attributes.locale, "ja");
  assert.equal(body.data.attributes.description, "テスト");
  assert.equal(body.data.attributes.feedbackEmail, "qa@example.com");
  assert.equal(body.data.attributes.marketingUrl, undefined);
  assert.deepEqual(body.data.relationships.app.data, { type: "apps", id: "app1" });
});

test("asc_get_beta_app_localization gets by id", async () => {
  const { client, calls } = fakeClient({ get: () => ({ data: { id: "loc1", attributes: { locale: "en-US" } } }) });
  await getBetaAppLocalizationTool.handler(parse(getBetaAppLocalizationTool, { localizationId: "loc1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/betaAppLocalizations/loc1");
});

test("asc_update_beta_app_localization PATCHes provided fields and rejects an empty update", async () => {
  const { client, calls } = fakeClient({});
  await updateBetaAppLocalizationTool.handler(parse(updateBetaAppLocalizationTool, {
    localizationId: "loc1", marketingUrl: "https://example.com",
  }), { client, config: cfg });
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v1/betaAppLocalizations/loc1");
  const body = patch.body as any;
  assert.equal(body.data.type, "betaAppLocalizations");
  assert.equal(body.data.id, "loc1");
  assert.equal(body.data.attributes.marketingUrl, "https://example.com");
  assert.equal(body.data.attributes.locale, undefined); // locale never sent on update
  await assert.rejects(
    () => updateBetaAppLocalizationTool.handler(parse(updateBetaAppLocalizationTool, { localizationId: "loc1" }), { client, config: cfg }),
    /at least one field/,
  );
});

test("asc_delete_beta_app_localization deletes by id", async () => {
  const { client, calls } = fakeClient({});
  const out = await deleteBetaAppLocalizationTool.handler(parse(deleteBetaAppLocalizationTool, { localizationId: "loc1" }), { client, config: cfg }) as { ok: boolean; localizationId: string };
  assert.equal(calls.find((c) => c.method === "DELETE")!.path, "/v1/betaAppLocalizations/loc1");
  assert.equal(out.ok, true);
  assert.equal(out.localizationId, "loc1");
});

// ── Beta app review ───────────────────────────────────────────────────────────

test("asc_list_beta_app_review_submissions filters by build and optional state", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "sub1", attributes: { betaReviewState: "WAITING_FOR_REVIEW" } }] });
  const out = await listBetaAppReviewSubmissionsTool.handler(parse(listBetaAppReviewSubmissionsTool, {
    buildId: "build1", reviewState: "WAITING_FOR_REVIEW",
  }), { client, config: cfg }) as Array<{ id: string }>;
  const list = calls.find((c) => c.method === "LIST")!;
  assert.equal(list.path, "/v1/betaAppReviewSubmissions");
  const q = list.query as any;
  assert.equal(q["filter[build]"], "build1");
  assert.equal(q["filter[betaReviewState]"], "WAITING_FOR_REVIEW");
  assert.equal(out[0]!.id, "sub1");
});

test("asc_list_beta_app_review_submissions omits state filter when not given", async () => {
  const { client, calls } = fakeClient({ list: () => [] });
  await listBetaAppReviewSubmissionsTool.handler(parse(listBetaAppReviewSubmissionsTool, { buildId: "build1" }), { client, config: cfg });
  const q = calls.find((c) => c.method === "LIST")!.query as any;
  assert.equal(q["filter[build]"], "build1");
  assert.equal(q["filter[betaReviewState]"], undefined);
});

test("asc_get_beta_app_review_submission gets by id", async () => {
  const { client, calls } = fakeClient({ get: () => ({ data: { id: "sub1", attributes: {} } }) });
  await getBetaAppReviewSubmissionTool.handler(parse(getBetaAppReviewSubmissionTool, { submissionId: "sub1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/betaAppReviewSubmissions/sub1");
});

test("asc_get_beta_app_review_details reads the app-scoped singular path", async () => {
  const { client, calls } = fakeClient({ get: () => ({ data: { id: "rd1", attributes: { demoAccountRequired: true } } }) });
  await getBetaAppReviewDetailsTool.handler(parse(getBetaAppReviewDetailsTool, { appId: "app1" }), { client, config: cfg });
  // asymmetric: read uses the singular app relationship path
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/apps/app1/betaAppReviewDetail");
});

test("asc_update_beta_app_review_details PATCHes by detail id (plural) and rejects empty", async () => {
  const { client, calls } = fakeClient({});
  await updateBetaAppReviewDetailsTool.handler(parse(updateBetaAppReviewDetailsTool, {
    reviewDetailId: "rd1", contactEmail: "lead@example.com", demoAccountRequired: false, demoAccountName: "demo",
  }), { client, config: cfg });
  const patch = calls.find((c) => c.method === "PATCH")!;
  // asymmetric: write uses the plural by-id path
  assert.equal(patch.path, "/v1/betaAppReviewDetails/rd1");
  const body = patch.body as any;
  assert.equal(body.data.type, "betaAppReviewDetails");
  assert.equal(body.data.id, "rd1");
  assert.equal(body.data.attributes.contactEmail, "lead@example.com");
  assert.equal(body.data.attributes.demoAccountRequired, false);
  assert.equal(body.data.attributes.demoAccountName, "demo");
  await assert.rejects(
    () => updateBetaAppReviewDetailsTool.handler(parse(updateBetaAppReviewDetailsTool, { reviewDetailId: "rd1" }), { client, config: cfg }),
    /at least one field/,
  );
});

// ── Beta license agreements ───────────────────────────────────────────────────

test("asc_list_beta_license_agreements filters by app only when given", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "la1", attributes: { agreementText: "EULA" } }] });
  const out = await listBetaLicenseAgreementsTool.handler(parse(listBetaLicenseAgreementsTool, { appId: "app1" }), { client, config: cfg }) as Array<{ id: string }>;
  const list = calls.find((c) => c.method === "LIST")!;
  assert.equal(list.path, "/v1/betaLicenseAgreements");
  assert.equal((list.query as any)["filter[app]"], "app1");
  assert.equal(out[0]!.id, "la1");

  const { client: c2, calls: calls2 } = fakeClient({ list: () => [] });
  await listBetaLicenseAgreementsTool.handler(parse(listBetaLicenseAgreementsTool, {}), { client: c2, config: cfg });
  assert.equal((calls2.find((c) => c.method === "LIST")!.query as any)["filter[app]"], undefined);
});

test("asc_get_beta_license_agreement gets by id", async () => {
  const { client, calls } = fakeClient({ get: () => ({ data: { id: "la1", attributes: { agreementText: "EULA" } } }) });
  await getBetaLicenseAgreementTool.handler(parse(getBetaLicenseAgreementTool, { betaLicenseAgreementId: "la1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/betaLicenseAgreements/la1");
});

test("asc_update_beta_license_agreement PATCHes agreementText, including null to clear", async () => {
  const { client, calls } = fakeClient({});
  await updateBetaLicenseAgreementTool.handler(parse(updateBetaLicenseAgreementTool, {
    betaLicenseAgreementId: "la1", agreementText: "New terms",
  }), { client, config: cfg });
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v1/betaLicenseAgreements/la1");
  const body = patch.body as any;
  assert.equal(body.data.type, "betaLicenseAgreements");
  assert.equal(body.data.id, "la1");
  assert.equal(body.data.attributes.agreementText, "New terms");

  const { client: c2, calls: calls2 } = fakeClient({});
  await updateBetaLicenseAgreementTool.handler(parse(updateBetaLicenseAgreementTool, {
    betaLicenseAgreementId: "la1", agreementText: null,
  }), { client: c2, config: cfg });
  assert.equal((calls2.find((c) => c.method === "PATCH")!.body as any).data.attributes.agreementText, null);
});
