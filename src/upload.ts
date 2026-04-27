import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { UploadOperation } from "./types.js";
import { log } from "./log.js";

/**
 * Run the asset-upload reservation pattern (used identically for screenshots, previews,
 * review attachments, IAP screenshots, and the new /v1/buildUploadFiles binary path).
 *
 * For each UploadOperation we PUT bytes [offset .. offset+length) of the source file to a
 * pre-signed URL with the headers Apple specified. The Authorization header is **not** sent
 * — these URLs are pre-authorized.
 *
 * Returns the lowercase-hex MD5 of the entire source file, which the caller must send
 * back to App Store Connect in a PATCH `{ uploaded: true, sourceFileChecksum }` to commit.
 */
export async function runUpload(
  filePath: string,
  ops: UploadOperation[],
  opts: { concurrency?: number; onProgress?: (uploaded: number, total: number) => void } = {},
): Promise<string> {
  if (!ops.length) throw new Error("No upload operations supplied; nothing to upload.");
  const concurrency = Math.max(1, opts.concurrency ?? 3);

  const fh = await open(filePath, "r");
  try {
    const stat = await fh.stat();
    const total = stat.size;
    let uploaded = 0;
    const md5 = createHash("md5");
    // Compute MD5 sequentially first (small cost vs. the upload itself, and avoids any reordering).
    {
      const chunkSize = 1 << 20; // 1 MiB
      const buf = Buffer.alloc(chunkSize);
      let pos = 0;
      while (pos < total) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(chunkSize, total - pos), pos);
        md5.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
      }
    }
    const checksum = md5.digest("hex");

    let cursor = 0;
    const errors: Error[] = [];
    const workers: Promise<void>[] = [];
    const inflight = new Set<Promise<void>>();
    const claim = () => (cursor < ops.length ? ops[cursor++] : undefined);

    const runOne = async () => {
      while (true) {
        const op = claim();
        if (!op) return;
        await uploadPart(fh, filePath, op);
        uploaded += op.length;
        opts.onProgress?.(uploaded, total);
      }
    };
    for (let i = 0; i < concurrency; i++) {
      const p = runOne().catch((err) => { errors.push(err as Error); });
      inflight.add(p);
      workers.push(p);
    }
    await Promise.all(workers);

    if (errors.length) {
      throw new Error(`Upload failed (${errors.length}/${ops.length} parts): ${errors.map((e) => e.message).join(" | ")}`);
    }
    return checksum;
  } finally {
    await fh.close();
  }
}

async function uploadPart(fh: FileHandle, filePath: string, op: UploadOperation) {
  const buf = Buffer.alloc(op.length);
  let pos = 0;
  while (pos < op.length) {
    const { bytesRead } = await fh.read(buf, pos, op.length - pos, op.offset + pos);
    if (bytesRead === 0) throw new Error(`Unexpected EOF reading ${filePath} at offset ${op.offset + pos}`);
    pos += bytesRead;
  }

  const headers: Record<string, string> = {};
  for (const { name, value } of op.requestHeaders) headers[name] = value;
  // Pre-signed: do NOT send Authorization. Some clients leak it; force-clear.
  delete headers.Authorization;

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(op.url, { method: op.method, headers, body: buf });
      if (res.ok || res.status === 200 || res.status === 201 || res.status === 204) return;
      const text = await safeText(res);
      const transient = res.status === 408 || res.status === 429 || res.status >= 500;
      if (transient && attempt < maxAttempts) {
        const backoff = 1000 * attempt + Math.floor(Math.random() * 500);
        log.warn(`upload chunk retry`, { url: redact(op.url), status: res.status, attempt, backoff });
        await sleep(backoff);
        continue;
      }
      throw new Error(`Chunk PUT failed: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 300)}`);
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      const backoff = 1000 * attempt + Math.floor(Math.random() * 500);
      log.warn(`upload chunk error`, { url: redact(op.url), err: String((err as Error).message), attempt, backoff });
      await sleep(backoff);
    }
  }
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}?…`;
  } catch {
    return url.slice(0, 80);
  }
}

async function safeText(res: Response): Promise<string> { try { return await res.text(); } catch { return ""; } }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
