import { redirect } from "@tanstack/react-router";
import { getRequest, setCookie } from "@tanstack/react-start/server";
import { env } from "../env/server";
import { isSameOriginRequest } from "./same-origin";
import { type AdminSession, AdminSessionCodec, type SessionCookie } from "./session";

export const sessions = new AdminSessionCodec(env.ADMIN_BOOTSTRAP_TOKEN);

export function readSession(request: Request): AdminSession | undefined {
  return sessions.read(request.headers.get("cookie"));
}

/** The `Set-Cookie` serialization of a session cookie, for handlers that build their own Response. */
export function serializeCookie(cookie: SessionCookie): string {
  return `${cookie.name}=${cookie.value}; Path=${cookie.path}; Max-Age=${cookie.maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function applyCookie(cookie: SessionCookie): void {
  setCookie(cookie.name, cookie.value, {
    maxAge: cookie.maxAge,
    path: cookie.path,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  });
}

/**
 * The guard at the top of every server function: a verified session, a
 * same-origin request for anything but a read, and a slid cookie when the
 * current one is old enough. A missing session redirects to the login page
 * rather than answering data, so a loader lands the operator there.
 */
export function requireSession(): AdminSession {
  const request = getRequest();
  const session = readSession(request);
  if (session === undefined) throw redirect({ to: "/login" });
  if (request.method !== "GET" && !isSameOriginRequest(request)) {
    throw redirect({ to: "/login" });
  }
  const refreshed = sessions.refresh(session);
  if (refreshed === undefined) return session;
  applyCookie(refreshed.cookie);
  return refreshed.session;
}
