import { encodeUtf8 } from "./binary.js";
import { SOURCE_LOCATOR_MAX_BYTES } from "./constants.js";
import { ProtocolError } from "./errors.js";
import type { SourceOriginRule } from "./types.js";

/**
 * The one canonical Source Origin path-prefix normalization. The parser, the
 * Postgres storage layer, and locator enforcement must all agree on this form
 * or the Source Locator allowlist breaks: "/" is the canonical root prefix,
 * every other prefix keeps its leading "/" and loses trailing "/" runs.
 */
export function normalizeSourceOriginPathPrefix(pathPrefix: string | undefined): string {
  if (pathPrefix === undefined) return "/";
  const rooted = pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
  const trimmed = rooted.replace(/\/+$/u, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * Accepts a Source Locator only when it is an absolute HTTPS URL without
 * credentials or a fragment and sits under one of the Space's allowed origins.
 * Capabilities, resolver expansions, and the internal optimize wire all pass
 * through this one check.
 */
export function validateSourceLocator(locator: string, rules: readonly SourceOriginRule[]): void {
  if (encodeUtf8(locator).byteLength > SOURCE_LOCATOR_MAX_BYTES) {
    throw new ProtocolError("claims_invalid", "source locator is too large");
  }

  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new ProtocolError("locator_not_allowed", "source locator must be an absolute URL");
  }

  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new ProtocolError(
      "locator_not_allowed",
      "source locator must be HTTPS without credentials or a fragment",
    );
  }

  const allowed = rules.some((rule) => {
    let origin: URL;
    try {
      origin = new URL(rule.origin);
    } catch {
      return false;
    }
    if (origin.origin !== url.origin || origin.pathname !== "/" || origin.search || origin.hash) {
      return false;
    }
    const normalizedPrefix = normalizeSourceOriginPathPrefix(rule.pathPrefix);
    if (normalizedPrefix === "/") return true;
    return url.pathname === normalizedPrefix || url.pathname.startsWith(`${normalizedPrefix}/`);
  });

  if (!allowed) throw new ProtocolError("locator_not_allowed", "source locator is not allowlisted");
}
