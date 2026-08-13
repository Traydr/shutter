import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "shutter_admin_session";
const SESSION_TTL_SECONDS = 15 * 60;

export interface AdminSession {
  csrfToken: string;
  expiresAt: number;
}

function digest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

function equal(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

// A sibling host on the same registrable domain can pin an extra cookie with
// the same name. Collect every candidate so one garbage value cannot lock the
// operator out; read() accepts the first that verifies.
function cookieValues(request: Request): readonly string[] {
  const values: string[] = [];
  for (const segment of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = segment.trim().split("=");
    if (name === COOKIE_NAME) values.push(value.join("="));
  }
  return values;
}

export class AdminSessionManager {
  readonly #bootstrapToken: string;
  readonly #now: () => number;

  constructor(bootstrapToken: string, now: () => number = Date.now) {
    this.#bootstrapToken = bootstrapToken;
    this.#now = now;
  }

  isConfigured(): boolean {
    return this.#bootstrapToken.length >= 32;
  }

  verifyBootstrapToken(candidate: string): boolean {
    return this.isConfigured() && equal(candidate, this.#bootstrapToken);
  }

  create(): { session: AdminSession; setCookie: string } {
    const session = {
      csrfToken: randomBytes(24).toString("base64url"),
      expiresAt: Math.floor(this.#now() / 1_000) + SESSION_TTL_SECONDS,
    };
    const payload = `${session.expiresAt}.${session.csrfToken}`;
    const value = `${payload}.${this.#signature(payload)}`;
    return {
      session,
      setCookie: `${COOKIE_NAME}=${value}; Path=/admin; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    };
  }

  read(request: Request): AdminSession | undefined {
    for (const value of cookieValues(request)) {
      const session = this.#readValue(value);
      if (session !== undefined) return session;
    }
    return undefined;
  }

  #readValue(value: string): AdminSession | undefined {
    const [expires, csrfToken, signature, ...extra] = value.split(".");
    if (
      expires === undefined ||
      csrfToken === undefined ||
      signature === undefined ||
      extra.length !== 0 ||
      !/^\d+$/u.test(expires) ||
      !/^[A-Za-z0-9_-]{32}$/u.test(csrfToken)
    ) {
      return undefined;
    }
    const expiresAt = Number(expires);
    const payload = `${expires}.${csrfToken}`;
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Math.floor(this.#now() / 1_000) ||
      !equal(signature, this.#signature(payload))
    ) {
      return undefined;
    }
    return { expiresAt, csrfToken };
  }

  verifyCsrf(
    request: Request,
    session: AdminSession,
    submitted: FormDataEntryValue | null,
  ): boolean {
    const origin = request.headers.get("origin");
    let samePublicOrigin = false;
    try {
      const browserOrigin = new URL(origin ?? "");
      const requestUrl = new URL(request.url);
      // Railway terminates TLS before Node, so the Request scheme can be HTTP.
      // The browser-controlled Origin must still be HTTPS and use the request Host.
      samePublicOrigin =
        browserOrigin.protocol === "https:" && browserOrigin.host === requestUrl.host;
    } catch {
      samePublicOrigin = false;
    }
    return samePublicOrigin && typeof submitted === "string" && equal(submitted, session.csrfToken);
  }

  clearCookie(): string {
    return `${COOKIE_NAME}=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
  }

  #signature(payload: string): string {
    return createHmac("sha256", this.#bootstrapToken).update(payload, "utf8").digest("base64url");
  }
}
