/**
 * The operator's theme, kept in a plain cookie so the server renders the
 * right one and the page never flashes. Dark unless the cookie says light.
 */
import { z } from "zod";

export const THEME_COOKIE = "theme";
export const THEME_SCHEMA = z.enum(["dark", "light"]);
export type Theme = z.infer<typeof THEME_SCHEMA>;

export function readTheme(cookieHeader: string | null): Theme {
  if (cookieHeader === null) return "dark";
  for (const part of cookieHeader.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name !== THEME_COOKIE) continue;
    const parsed = THEME_SCHEMA.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return "dark";
}

export function serializeThemeCookie(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; Secure; SameSite=Lax`;
}

/** Where the toggle sends the operator back: a path on this site, or the front page. */
export function safeReturnPath(candidate: string): string {
  return candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "/";
}
