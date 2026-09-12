import { describe, expect, it } from "vitest";
import { AdminSessionCodec, SESSION_COOKIE_NAME } from "./session.js";

const SECRET = "bootstrap_token_abcdefghijklmnopqrstuvwxyz0123";
const START = 1_800_000_000;

function codecAt(clock: { now: number }, secret = SECRET) {
  return new AdminSessionCodec(secret, () => clock.now);
}

function header(value: string): string {
  return `${SESSION_COOKIE_NAME}=${value}`;
}

describe("admin session", () => {
  it("issues a cookie the same codec reads back", () => {
    const clock = { now: START };
    const codec = codecAt(clock);
    const { session, cookie } = codec.create();
    expect(cookie).toMatchObject({
      name: SESSION_COOKIE_NAME,
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 8 * 60 * 60,
    });
    expect(codec.read(header(cookie.value))).toEqual(session);
    expect(codec.read(`other=1; ${header("garbage")}; ${header(cookie.value)}`)).toEqual(session);
  });

  it("rejects a tampered, foreign, or expired cookie", () => {
    const clock = { now: START };
    const codec = codecAt(clock);
    const { cookie } = codec.create();
    const [issued, refreshed, expires, signature] = cookie.value.split(".");
    expect(codec.read(header(`${issued}.${refreshed}.${Number(expires) + 1}.${signature}`))).toBe(
      undefined,
    );
    expect(codecAt(clock, "x".repeat(40)).read(header(cookie.value))).toBeUndefined();
    expect(new AdminSessionCodec("short").read(header(cookie.value))).toBeUndefined();
    clock.now = START + 8 * 60 * 60;
    expect(codec.read(header(cookie.value))).toBeUndefined();
  });

  it("slides the idle limit on activity and stops at the absolute limit", () => {
    const clock = { now: START };
    const codec = codecAt(clock);
    const { session } = codec.create();

    clock.now = START + 60;
    expect(codec.refresh(session)).toBeUndefined();

    clock.now = START + 6 * 60;
    const first = codec.refresh(session);
    expect(first?.session).toEqual({
      issuedAt: START,
      refreshedAt: START + 6 * 60,
      expiresAt: START + 6 * 60 + 8 * 60 * 60,
    });
    expect(codec.read(header(first?.cookie.value ?? ""))).toEqual(first?.session);

    // Near the absolute limit the refresh extends only up to it, never past.
    clock.now = START + 7 * 24 * 60 * 60 - 60 * 60;
    const nearEnd = codec.refresh({
      issuedAt: START,
      refreshedAt: clock.now - 2 * 60 * 60,
      expiresAt: clock.now + 30 * 60,
    });
    expect(nearEnd?.session.expiresAt).toBe(START + 7 * 24 * 60 * 60);
    expect(nearEnd?.cookie.maxAge).toBe(60 * 60);

    clock.now = START + 7 * 24 * 60 * 60;
    expect(codec.read(header(nearEnd?.cookie.value ?? ""))).toBeUndefined();
  });

  it("clears with an expired cookie of the same shape", () => {
    expect(codecAt({ now: START }).clearCookie()).toMatchObject({
      name: SESSION_COOKIE_NAME,
      value: "",
      maxAge: 0,
    });
  });
});
