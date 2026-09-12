/**
 * The operator session: a signed, sliding cookie. The value carries when it
 * was issued, when it was last refreshed, and when it expires; the signature
 * is an HMAC over those three with the bootstrap token as the key, so
 * rotating the token signs every operator out. No session state is stored.
 *
 * Idle limit eight hours, refreshed on activity; absolute limit seven days.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "shutter_admin_session";
const IDLE_SECONDS = 8 * 60 * 60;
const ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;
/** How long a cookie stays as issued before activity re-issues it. */
const REFRESH_AFTER_SECONDS = 5 * 60;
const VALUE_PATTERN = /^(\d{1,12})\.(\d{1,12})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/u;

export interface AdminSession {
  /** Unix seconds. */
  issuedAt: number;
  refreshedAt: number;
  expiresAt: number;
}

/** A session together with the cookie that carries it. */
export interface IssuedSession {
  session: AdminSession;
  cookie: SessionCookie;
}

/** What the HTTP layer needs to set or clear the cookie. */
export interface SessionCookie {
  name: string;
  value: string;
  maxAge: number;
  path: "/";
  httpOnly: true;
  secure: true;
  sameSite: "strict";
}

function digest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

// A sibling host on the same registrable domain can pin an extra cookie with
// the same name; read every candidate so one stray value cannot lock the
// operator out.
function cookieValues(cookieHeader: string | null): readonly string[] {
  const values: string[] = [];
  for (const segment of (cookieHeader ?? "").split(";")) {
    const [name, ...value] = segment.trim().split("=");
    if (name === SESSION_COOKIE_NAME) values.push(value.join("="));
  }
  return values;
}

export class AdminSessionCodec {
  readonly #secret: string;
  readonly #now: () => number;

  /** `now` answers Unix seconds. */
  constructor(secret: string, now: () => number = () => Math.floor(Date.now() / 1_000)) {
    this.#secret = secret;
    this.#now = now;
  }

  isConfigured(): boolean {
    return this.#secret.length >= 32;
  }

  create(): IssuedSession {
    const now = this.#now();
    const session: AdminSession = {
      issuedAt: now,
      refreshedAt: now,
      expiresAt: now + IDLE_SECONDS,
    };
    return { session, cookie: this.#cookie(session) };
  }

  read(cookieHeader: string | null): AdminSession | undefined {
    if (!this.isConfigured()) return undefined;
    for (const value of cookieValues(cookieHeader)) {
      const session = this.#readValue(value);
      if (session !== undefined) return session;
    }
    return undefined;
  }

  /**
   * A fresh cookie once the current one is older than the refresh interval,
   * extending the idle limit without passing the absolute one. `undefined`
   * means the cookie the browser holds is still the right one.
   */
  refresh(session: AdminSession): IssuedSession | undefined {
    const now = this.#now();
    if (now - session.refreshedAt < REFRESH_AFTER_SECONDS) return undefined;
    const expiresAt = Math.min(now + IDLE_SECONDS, session.issuedAt + ABSOLUTE_SECONDS);
    if (expiresAt <= session.expiresAt) return undefined;
    const refreshed: AdminSession = { issuedAt: session.issuedAt, refreshedAt: now, expiresAt };
    return { session: refreshed, cookie: this.#cookie(refreshed) };
  }

  clearCookie(): SessionCookie {
    return {
      name: SESSION_COOKIE_NAME,
      value: "",
      maxAge: 0,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    };
  }

  #cookie(session: AdminSession): SessionCookie {
    const payload = `${session.issuedAt}.${session.refreshedAt}.${session.expiresAt}`;
    return {
      name: SESSION_COOKIE_NAME,
      value: `${payload}.${this.#sign(payload)}`,
      maxAge: Math.max(0, session.expiresAt - this.#now()),
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "strict",
    };
  }

  #readValue(value: string): AdminSession | undefined {
    const match = VALUE_PATTERN.exec(value);
    if (match === null) return undefined;
    const [, issued, refreshed, expires, signature] = match;
    if (
      issued === undefined ||
      refreshed === undefined ||
      expires === undefined ||
      signature === undefined
    ) {
      return undefined;
    }
    const payload = `${issued}.${refreshed}.${expires}`;
    if (!timingSafeEqual(digest(signature), digest(this.#sign(payload)))) return undefined;
    const session: AdminSession = {
      issuedAt: Number(issued),
      refreshedAt: Number(refreshed),
      expiresAt: Number(expires),
    };
    const now = this.#now();
    if (session.expiresAt <= now || session.issuedAt + ABSOLUTE_SECONDS <= now) return undefined;
    if (session.refreshedAt < session.issuedAt || session.expiresAt < session.refreshedAt) {
      return undefined;
    }
    return session;
  }

  #sign(payload: string): string {
    return createHmac("sha256", this.#secret).update(payload, "utf8").digest("base64url");
  }
}
