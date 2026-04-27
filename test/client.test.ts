import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { AscClient, AscApiError } from "../src/client.ts";
import { JwtMinter } from "../src/auth.ts";

function pem() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function makeClient(baseUrlOverride?: string) {
  const minter = new JwtMinter({ keyId: "K", issuerId: "I", privateKeyPem: pem(), preferRestUpload: true });
  return new AscClient(minter);
}

async function withServer(handler: (req: IncomingMessage, res: ServerResponse, callCount: number) => Promise<void> | void): Promise<{ origin: string; close: () => Promise<void> }> {
  let calls = 0;
  const server = createServer(async (req, res) => {
    calls++;
    try { await handler(req, res, calls); } catch (e) { res.statusCode = 500; res.end(String(e)); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    origin: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("AscClient: surfaces JSON:API errors with code, title, and pointer", async () => {
  const { origin, close } = await withServer((_req, res) => {
    res.statusCode = 409;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      errors: [{
        status: "409", code: "STATE_ERROR.SCREENSHOTS_REQUIRED",
        title: "The provided entity is in an invalid state.",
        detail: "App Store Version must have at least one screenshot.",
        source: { pointer: "/data/relationships/build" },
      }],
    }));
  });
  try {
    const client = makeClient();
    await assert.rejects(
      () => client.get(`${origin}/v1/test`),
      (err: Error) => {
        assert.ok(err instanceof AscApiError);
        assert.match(err.message, /STATE_ERROR\.SCREENSHOTS_REQUIRED/);
        assert.match(err.message, /\/data\/relationships\/build/);
        return true;
      },
    );
  } finally { await close(); }
});

test("AscClient: retries 429 with exponential backoff and eventually succeeds", async () => {
  const { origin, close } = await withServer((_req, res, n) => {
    if (n < 3) {
      res.statusCode = 429;
      res.setHeader("retry-after", "0");
      res.end("{\"errors\":[{\"status\":\"429\",\"code\":\"RATE_LIMIT_EXCEEDED\",\"title\":\"Rate limited\"}]}");
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: { id: "1", type: "apps", attributes: { name: "ok" } } }));
  });
  try {
    const client = makeClient();
    const out = await client.get(`${origin}/v1/test`);
    assert.deepEqual((out as { data: { attributes: { name: string } } }).data.attributes.name, "ok");
  } finally { await close(); }
});

test("AscClient: paginates via links.next", async () => {
  const pages: Record<string, unknown> = {
    "/v1/items?limit=200": {
      data: [{ type: "items", id: "1" }, { type: "items", id: "2" }],
      links: { next: "PLACEHOLDER" },
    },
    "/v1/items?cursor=p2": {
      data: [{ type: "items", id: "3" }],
      links: {},
    },
  };
  const { origin, close } = await withServer((req, res) => {
    res.setHeader("content-type", "application/json");
    const path = req.url ?? "";
    let body = pages[path];
    if (!body) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    body = JSON.parse(JSON.stringify(body));
    if ((body as { links?: { next?: string } }).links?.next === "PLACEHOLDER") {
      (body as { links: { next: string } }).links.next = `${origin}/v1/items?cursor=p2`;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(body));
  });
  try {
    const client = makeClient();
    const all = await client.getAll(`${origin}/v1/items`);
    assert.equal(all.length, 3);
    assert.deepEqual(all.map((r) => r.id), ["1", "2", "3"]);
  } finally { await close(); }
});

test("AscClient: sends Authorization header with the bearer token", async () => {
  let seenAuth: string | undefined;
  const { origin, close } = await withServer((req, res) => {
    seenAuth = (req.headers.authorization as string | undefined) ?? undefined;
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [] }));
  });
  try {
    const client = makeClient();
    await client.get(`${origin}/v1/test`);
    assert.ok(seenAuth?.startsWith("Bearer "));
    assert.ok((seenAuth ?? "").length > 100, "should include a real JWT");
  } finally { await close(); }
});
