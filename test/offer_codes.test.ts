import test from "node:test";
import assert from "node:assert/strict";
import {
  listOfferCodesTool, createOfferCodeTool, createOfferCodeCustomCodesTool,
  createOfferCodeOneTimeCodesTool, listWinBackOffersTool, createWinBackOfferTool, deleteWinBackOfferTool,
} from "../src/tools/offer_codes.ts";
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

test("asc_create_offer_code (paid) posts eligibilities + inline price", async () => {
  const { client, calls } = fakeClient({
    list: () => [{ id: "spp_199", attributes: { customerPrice: "1.99" } }],
    post: () => ({ data: { id: "oc1" } }),
  });
  await createOfferCodeTool.handler(parse(createOfferCodeTool, {
    subscriptionId: "sub1", name: "Welcome", customerEligibilities: ["NEW", "EXPIRED"],
    offerMode: "PAY_AS_YOU_GO", duration: "ONE_MONTH", customerPrice: "1.99",
  }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "subscriptionOfferCodes");
  assert.deepEqual(body.data.attributes.customerEligibilities, ["NEW", "EXPIRED"]);
  const lid = body.data.relationships.prices.data[0].id;
  const inc = body.included[0];
  assert.equal(inc.id, lid);
  assert.equal(inc.type, "subscriptionOfferCodePrices");
  assert.equal(inc.relationships.subscriptionPricePoint.data.id, "spp_199");
});

test("asc_create_offer_code (FREE_TRIAL) carries no price", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "oc2" } }) });
  await createOfferCodeTool.handler(parse(createOfferCodeTool, {
    subscriptionId: "sub1", name: "Free", customerEligibilities: ["NEW"], offerMode: "FREE_TRIAL", duration: "ONE_WEEK",
  }), { client, config: cfg });
  assert.equal(calls.some((c) => c.method === "LIST"), false);
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.relationships.prices, undefined);
});

test("asc_create_offer_code_custom_codes posts the code + offerCode relationship", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "cc1" } }) });
  await createOfferCodeCustomCodesTool.handler(parse(createOfferCodeCustomCodesTool, {
    offerCodeId: "oc1", customCode: "WELCOME2026", numberOfCodes: 100, expirationDate: "2026-12-31",
  }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "subscriptionOfferCodeCustomCodes");
  assert.equal(body.data.attributes.customCode, "WELCOME2026");
  assert.equal(body.data.attributes.numberOfCodes, 100);
  assert.deepEqual(body.data.relationships.offerCode.data, { type: "subscriptionOfferCodes", id: "oc1" });
});

test("asc_create_offer_code_one_time_codes posts a batch", async () => {
  const { client, calls } = fakeClient({ post: () => ({ data: { id: "otb1" } }) });
  const out = await createOfferCodeOneTimeCodesTool.handler(parse(createOfferCodeOneTimeCodesTool, { offerCodeId: "oc1", numberOfCodes: 500 }), { client, config: cfg }) as { batchId: string };
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "subscriptionOfferCodeOneTimeUseCodes");
  assert.equal(body.data.attributes.numberOfCodes, 500);
  assert.equal(out.batchId, "otb1");
});

test("asc_create_win_back_offer (paid) posts offerId + inline winBackOfferPrices", async () => {
  const { client, calls } = fakeClient({
    list: () => [{ id: "spp_099", attributes: { customerPrice: "0.99" } }],
    post: () => ({ data: { id: "wb1" } }),
  });
  await createWinBackOfferTool.handler(parse(createWinBackOfferTool, {
    subscriptionId: "sub1", referenceName: "Comeback", offerId: "COMEBACK", offerMode: "PAY_AS_YOU_GO",
    duration: "THREE_MONTHS", customerPrice: "0.99",
  }), { client, config: cfg });
  const body = calls.find((c) => c.method === "POST")!.body as any;
  assert.equal(body.data.type, "winBackOffers");
  assert.equal(body.data.attributes.offerId, "COMEBACK");
  assert.equal(body.included[0].type, "winBackOfferPrices");
  assert.equal(body.included[0].relationships.subscriptionPricePoint.data.id, "spp_099");
});

test("asc_list_offer_codes / asc_list_win_back_offers hit the subscription sub-resources", async () => {
  const { client, calls } = fakeClient({ list: () => [{ id: "x", attributes: {} }] });
  await listOfferCodesTool.handler(parse(listOfferCodesTool, { subscriptionId: "sub1" }), { client, config: cfg });
  await listWinBackOffersTool.handler(parse(listWinBackOffersTool, { subscriptionId: "sub1" }), { client, config: cfg });
  const paths = calls.filter((c) => c.method === "LIST").map((c) => c.path);
  assert.ok(paths.includes("/v1/subscriptions/sub1/offerCodes"));
  assert.ok(paths.includes("/v1/subscriptions/sub1/winBackOffers"));
});

test("asc_delete_win_back_offer DELETEs the offer", async () => {
  const { client, calls } = fakeClient({});
  const out = await deleteWinBackOfferTool.handler(parse(deleteWinBackOfferTool, { winBackOfferId: "wb1" }), { client, config: cfg }) as { deleted: string };
  assert.equal(calls.find((c) => c.method === "DELETE")!.path, "/v1/winBackOffers/wb1");
  assert.equal(out.deleted, "wb1");
});
