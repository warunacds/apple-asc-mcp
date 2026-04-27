import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AscConfig {
  keyId: string;
  issuerId: string;
  privateKeyPem: string;
  /** Path the .p8 was loaded from, for altool's --apiKey lookup. May be undefined when key was supplied inline. */
  privateKeyPath?: string;
  /** Optional vendor flag to enable the modern REST upload path. Defaults to true. */
  preferRestUpload: boolean;
}

export class ConfigError extends Error {}

export function loadConfig(): AscConfig {
  const keyId = process.env.APP_STORE_CONNECT_KEY_ID?.trim();
  const issuerId = process.env.APP_STORE_CONNECT_ISSUER_ID?.trim();
  if (!keyId) throw new ConfigError("APP_STORE_CONNECT_KEY_ID is required (10-char Key ID from App Store Connect → Users and Access → Integrations).");
  if (!issuerId) throw new ConfigError("APP_STORE_CONNECT_ISSUER_ID is required (UUID from the same page).");

  const inlinePem = process.env.APP_STORE_CONNECT_PRIVATE_KEY?.trim();
  let pemPath = process.env.APP_STORE_CONNECT_PRIVATE_KEY_PATH?.trim();

  let pem: string | undefined;
  if (inlinePem) {
    pem = inlinePem.includes("BEGIN") ? inlinePem : `-----BEGIN PRIVATE KEY-----\n${inlinePem}\n-----END PRIVATE KEY-----\n`;
  } else if (pemPath) {
    pem = readFileSync(pemPath, "utf8");
  } else {
    // altool's canonical lookup: ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 (and three other paths)
    const candidates = [
      join(homedir(), ".appstoreconnect", "private_keys", `AuthKey_${keyId}.p8`),
      join(homedir(), ".private_keys", `AuthKey_${keyId}.p8`),
      join(process.cwd(), "private_keys", `AuthKey_${keyId}.p8`),
      join(process.cwd(), `AuthKey_${keyId}.p8`),
    ];
    for (const c of candidates) {
      if (existsSync(c)) {
        pemPath = c;
        pem = readFileSync(c, "utf8");
        break;
      }
    }
  }
  if (!pem) {
    throw new ConfigError(
      `Could not load App Store Connect private key. Set APP_STORE_CONNECT_PRIVATE_KEY_PATH to your AuthKey_${keyId}.p8 file, ` +
      `or place it under ~/.appstoreconnect/private_keys/, or pass APP_STORE_CONNECT_PRIVATE_KEY with the PEM contents.`,
    );
  }

  const preferRestUploadEnv = process.env.APP_STORE_CONNECT_PREFER_REST_UPLOAD?.toLowerCase().trim();
  const preferRestUpload = preferRestUploadEnv === "false" ? false : true;

  return { keyId, issuerId, privateKeyPem: pem, privateKeyPath: pemPath, preferRestUpload };
}
