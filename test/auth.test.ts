import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { jwtVerify, importSPKI } from "jose";
import { JwtMinter } from "../src/auth.ts";

function makeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

test("JwtMinter: signs ES256 JWTs with the right claims", async () => {
  const { pub, priv } = makeKey();
  const minter = new JwtMinter({
    keyId: "ABCDEFGHIJ",
    issuerId: "11111111-2222-3333-4444-555555555555",
    privateKeyPem: priv,
    preferRestUpload: true,
  });
  const token = await minter.getToken();
  const pubKey = await importSPKI(pub, "ES256");
  const { payload, protectedHeader } = await jwtVerify(token, pubKey, {
    audience: "appstoreconnect-v1",
    issuer: "11111111-2222-3333-4444-555555555555",
  });
  assert.equal(protectedHeader.alg, "ES256");
  assert.equal(protectedHeader.kid, "ABCDEFGHIJ");
  assert.equal(protectedHeader.typ, "JWT");
  const now = Math.floor(Date.now() / 1000);
  assert.ok(typeof payload.iat === "number" && payload.iat <= now);
  assert.ok(typeof payload.exp === "number");
  // Apple rejects exp >= now+1200; we configure 18min (1080).
  assert.ok((payload.exp as number) - now < 1200, `exp - now should be < 1200, got ${(payload.exp as number) - now}`);
  assert.ok((payload.exp as number) - now > 60, `exp should be at least a minute in the future`);
});

test("JwtMinter: caches token until near expiry", async () => {
  const { priv } = makeKey();
  const minter = new JwtMinter({
    keyId: "KEYIDXXXXX",
    issuerId: "iss",
    privateKeyPem: priv,
    preferRestUpload: true,
  });
  const a = await minter.getToken();
  const b = await minter.getToken();
  assert.equal(a, b, "second call should hit cache");
});

test("JwtMinter: surfaces a clear error on a bad PEM", async () => {
  const minter = new JwtMinter({
    keyId: "BAD",
    issuerId: "iss",
    privateKeyPem: "-----BEGIN PRIVATE KEY-----\nthis is not valid base64===\n-----END PRIVATE KEY-----",
    preferRestUpload: true,
  });
  await assert.rejects(() => minter.getToken(), /Could not import the .p8 private key/);
});
