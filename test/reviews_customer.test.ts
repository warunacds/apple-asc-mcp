import test from "node:test";
import assert from "node:assert/strict";
import {
  listCustomerReviewsTool, getCustomerReviewTool, respondToReviewTool, deleteReviewResponseTool,
} from "../src/tools/reviews_customer.ts";
import type { AscClient } from "../src/client.ts";
import type { AscConfig } from "../src/config.ts";

// Handler tests against a recording stub client (the AscClient is covered in client.test.ts).
// Focus: review listing path, and the response upsert (create vs update) + delete.

interface Call { method: string; path: string; body?: unknown; }

function fakeClient(responses: {
  list?: (path: string) => unknown[];
  get?: (path: string) => unknown;
  post?: (path: string, body: unknown) => unknown;
  patch?: (path: string, body: unknown) => unknown;
  del?: (path: string) => unknown;
}) {
  const calls: Call[] = [];
  const client = {
    async list(path: string) { calls.push({ method: "LIST", path }); return responses.list?.(path) ?? []; },
    async get(path: string) { calls.push({ method: "GET", path }); return responses.get?.(path); },
    async post(path: string, body: unknown) { calls.push({ method: "POST", path, body }); return responses.post?.(path, body) ?? { data: { id: "new" } }; },
    async patch(path: string, body: unknown) { calls.push({ method: "PATCH", path, body }); return responses.patch?.(path, body) ?? { data: { id: "patched" } }; },
    async delete(path: string) { calls.push({ method: "DELETE", path }); return responses.del?.(path); },
  } as unknown as AscClient;
  return { client, calls };
}

const cfg = { keyId: "K", issuerId: "I", privateKeyPem: "", preferRestUpload: true } as AscConfig;
const parse = (t: { inputSchema: { parse: (x: unknown) => unknown } }, x: unknown) => t.inputSchema.parse(x);

test("asc_list_customer_reviews hits the app's reviews and flattens", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "rev1", attributes: { rating: 5, title: "Great" } }] });
  const out = await listCustomerReviewsTool.handler(parse(listCustomerReviewsTool, { appId: "app1", rating: 5, territory: "USA" }), { client, config: cfg }) as Array<{ id: string; rating?: number }>;
  assert.equal(calls.find((c) => c.method === "LIST")!.path, "/v1/apps/app1/customerReviews");
  assert.equal(out[0]!.id, "rev1");
  assert.equal(out[0]!.rating, 5);
});

test("asc_get_customer_review includes the response", async () => {
  const { client, calls } = fakeClient({ get: () => ({ data: { id: "rev1" }, included: [] }) });
  await getCustomerReviewTool.handler(parse(getCustomerReviewTool, { reviewId: "rev1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "GET")!.path, "/v1/customerReviews/rev1");
});

test("asc_respond_to_review creates a response when none exists", async () => {
  const { client, calls } = fakeClient({
    get: () => ({ data: null }), // no existing response
    post: () => ({ data: { id: "resp1" } }),
  });
  const out = await respondToReviewTool.handler(parse(respondToReviewTool, { reviewId: "rev1", responseBody: "Thanks!" }), { client, config: cfg }) as { action: string };
  assert.equal(out.action, "created");
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "customerReviewResponses");
  assert.equal(body.data.attributes.responseBody, "Thanks!");
  assert.deepEqual(body.data.relationships.review.data, { type: "customerReviews", id: "rev1" });
});

test("asc_respond_to_review updates the existing response", async () => {
  const { client, calls } = fakeClient({
    get: () => ({ data: { id: "resp1" } }), // existing response
    patch: () => ({ data: { id: "resp1" } }),
  });
  const out = await respondToReviewTool.handler(parse(respondToReviewTool, { reviewId: "rev1", responseBody: "Updated" }), { client, config: cfg }) as { action: string };
  assert.equal(out.action, "updated");
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.equal(patch.path, "/v1/customerReviewResponses/resp1");
  assert.equal((patch.body as any).data.attributes.responseBody, "Updated");
});

test("asc_delete_review_response DELETEs the response", async () => {
  const { client, calls } = fakeClient({});
  await deleteReviewResponseTool.handler(parse(deleteReviewResponseTool, { responseId: "resp1" }), { client, config: cfg });
  assert.equal(calls.find((c) => c.method === "DELETE")!.path, "/v1/customerReviewResponses/resp1");
});
