import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { runUpload } from "../src/upload.ts";
import type { UploadOperation } from "../src/types.ts";

interface ReceivedPart {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

async function withMockServer<T>(fn: (origin: string, received: ReceivedPart[]) => Promise<T>): Promise<T> {
  const received: ReceivedPart[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    received.push({
      url: req.url ?? "",
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")])),
      body: Buffer.concat(chunks),
    });
    // Reject if Authorization sneaks through — pre-signed URLs must not see it.
    if (req.headers.authorization) {
      res.statusCode = 400;
      res.end("Authorization header should not be sent to pre-signed URL");
      return;
    }
    res.statusCode = 200;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const origin = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(origin, received);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("runUpload: PUTs each chunk with the correct byte range and returns the file MD5", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asc-upload-test-"));
  const filePath = join(dir, "blob.bin");
  // 10 KiB of random bytes split into three operations of unequal length.
  const data = randomBytes(10 * 1024);
  await writeFile(filePath, data);

  await withMockServer(async (origin, received) => {
    const ops: UploadOperation[] = [
      { method: "PUT", url: `${origin}/part0`, offset: 0, length: 4096, requestHeaders: [{ name: "Content-Type", value: "application/octet-stream" }] },
      { method: "PUT", url: `${origin}/part1`, offset: 4096, length: 4096, requestHeaders: [{ name: "Content-Type", value: "application/octet-stream" }] },
      { method: "PUT", url: `${origin}/part2`, offset: 8192, length: 2048, requestHeaders: [{ name: "Content-Type", value: "application/octet-stream" }] },
    ];
    const checksum = await runUpload(filePath, ops);

    // Verify checksum
    const expected = createHash("md5").update(data).digest("hex");
    assert.equal(checksum, expected, "MD5 should match the whole file");

    // Verify all parts arrived and their bytes line up
    assert.equal(received.length, 3);
    const byUrl = new Map(received.map((r) => [r.url, r] as const));
    assert.equal(byUrl.get("/part0")!.body.compare(data, 0, 4096), 0);
    assert.equal(byUrl.get("/part1")!.body.compare(data, 4096, 8192), 0);
    assert.equal(byUrl.get("/part2")!.body.compare(data, 8192, 10240), 0);

    // Verify Apple-supplied request headers were forwarded
    for (const part of received) {
      assert.equal(part.headers["content-type"], "application/octet-stream");
    }
  });

  await unlink(filePath);
});

test("runUpload: throws when no operations supplied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asc-upload-test-"));
  const filePath = join(dir, "empty.bin");
  await writeFile(filePath, Buffer.alloc(0));
  await assert.rejects(() => runUpload(filePath, []), /No upload operations/);
});

test("runUpload: never sends Authorization header", async () => {
  const dir = await mkdtemp(join(tmpdir(), "asc-upload-test-"));
  const filePath = join(dir, "blob.bin");
  await writeFile(filePath, randomBytes(1024));

  await withMockServer(async (origin, received) => {
    const ops: UploadOperation[] = [
      {
        method: "PUT",
        url: `${origin}/x`,
        offset: 0,
        length: 1024,
        // Even if Apple's headers contain Authorization (they don't, but defensive), we strip it.
        requestHeaders: [
          { name: "Content-Type", value: "application/octet-stream" },
          { name: "Authorization", value: "Bearer FAKE_LEAKED_TOKEN" },
        ],
      },
    ];
    await runUpload(filePath, ops);
    assert.equal(received.length, 1);
    assert.equal(received[0]!.headers.authorization, undefined, "Authorization should never be sent to pre-signed URLs");
  });
});
