import { SignJWT, importPKCS8 } from "jose";
import type { KeyLike } from "jose";
import type { AscConfig } from "./config.js";
import { log } from "./log.js";

/**
 * Apple rejects tokens with `exp >= now + 1200` (20-minute hard cap). We mint 18-minute tokens
 * and refresh ~60 seconds before expiry. Re-using a token across requests is the largest single
 * latency win on this API — generating one ECDSA signature per request adds tens of ms.
 */
const TOKEN_LIFETIME_S = 18 * 60;
const REFRESH_LEAD_S = 60;

interface CachedToken {
  token: string;
  expiresAt: number; // unix seconds
}

export class JwtMinter {
  private cached: CachedToken | undefined;
  private key: KeyLike | undefined;

  constructor(private readonly cfg: AscConfig) {}

  async getToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.expiresAt > now + REFRESH_LEAD_S) {
      return this.cached.token;
    }
    const token = await this.mint(now);
    this.cached = { token, expiresAt: now + TOKEN_LIFETIME_S };
    log.debug("minted new App Store Connect JWT", { kid: this.cfg.keyId, exp_in_s: TOKEN_LIFETIME_S });
    return token;
  }

  private async mint(now: number): Promise<string> {
    if (!this.key) {
      try {
        this.key = await importPKCS8(this.cfg.privateKeyPem, "ES256");
      } catch (err) {
        throw new Error(
          `Could not import the .p8 private key as PKCS#8 / ES256. ` +
          `Make sure the file is the unmodified PEM Apple gave you (starts with "-----BEGIN PRIVATE KEY-----"). Underlying error: ${(err as Error).message}`,
        );
      }
    }
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.cfg.keyId, typ: "JWT" })
      .setIssuer(this.cfg.issuerId)
      .setIssuedAt(now - 5)
      .setExpirationTime(now + TOKEN_LIFETIME_S)
      .setAudience("appstoreconnect-v1")
      .sign(this.key);
  }
}
