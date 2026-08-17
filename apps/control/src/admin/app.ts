import { SpacePolicyValidationError } from "@shutter/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { EdgeRefreshStatus } from "../edge-refresh-status.js";
import { type SpaceRecord, type SpaceRegistry, SpaceRegistryError } from "../spaces/registry.js";
import { deploymentCoverage } from "./deployment-coverage.js";
import { AdminInputError, formText, parseCreateSpaceForm, parseEditSpaceForm } from "./input.js";
import { type AdminSession, AdminSessionManager } from "./session.js";
import {
  type AdminOverview,
  errorView,
  loginView,
  overviewView,
  type SpaceDetail,
  spaceView,
  unavailableView,
} from "./view.js";

export interface AdminRuntime {
  bootstrapToken(): string | undefined;
  imgproxyAllowedSources(): string | undefined;
  registry?: SpaceRegistry;
  edgeRefreshStatus(): EdgeRefreshStatus | undefined;
  now?(): number;
}

type AdminEnv = { Variables: { session: AdminSession; form: FormData } };

const LOGIN_LOCKOUT_THRESHOLD = 5;
const LOGIN_LOCKOUT_MS = 60_000;

function html(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=UTF-8",
      // Not no-referrer: under that policy browsers serialize the Origin
      // header as "null" even on same-origin form POSTs (Fetch spec), which
      // would fail the CSRF middleware's same-host Origin check. same-origin
      // keeps the referrer inside this host and the Origin header real.
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...headers,
    },
  });
}

function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, {
    status: 303,
    headers: { "cache-control": "private, no-store", location, ...headers },
  });
}

function statusFor(cause: unknown): number {
  if (cause instanceof AdminInputError || cause instanceof SpacePolicyValidationError) return 400;
  if (cause instanceof SpaceRegistryError) {
    if (cause.code === "not_found") return 404;
    if (cause.code === "unavailable") return 503;
    return 400;
  }
  return 503;
}

function publicMessage(cause: unknown): string {
  if (cause instanceof SpaceRegistryError) return cause.message;
  if (cause instanceof SpacePolicyValidationError) return cause.message;
  if (cause instanceof AdminInputError) return "The submitted values are not valid.";
  return "The Space Registry is unavailable.";
}

async function currentSpace(registry: SpaceRegistry, spaceId: string): Promise<SpaceRecord> {
  const space = await registry.getSpace(spaceId);
  if (space === undefined) throw new SpaceRegistryError("not_found", "The Space does not exist.");
  return space;
}

async function loadSpaceDetail(
  registry: SpaceRegistry,
  spaceId: string,
): Promise<{
  space: SpaceRecord;
  generation: number;
  apiTokens: Awaited<ReturnType<SpaceRegistry["listApiTokens"]>>;
  capabilityKeys: Awaited<ReturnType<SpaceRegistry["listCapabilityKeys"]>>;
}> {
  const [space, generation, apiTokens, capabilityKeys] = await Promise.all([
    currentSpace(registry, spaceId),
    registry.getGeneration(),
    registry.listApiTokens(spaceId),
    registry.listCapabilityKeys(spaceId),
  ]);
  return { space, generation: generation.generation, apiTokens, capabilityKeys };
}

/**
 * The post-write notice renders only when the requested generation matches the
 * freshly read registry state, so the page can never claim an advance that did
 * not happen.
 */
function generationNotice(requested: string | null, actual: number): string | undefined {
  return requested !== null && requested === String(actual)
    ? `The registry is now at generation ${actual}.`
    : undefined;
}

function parseTokenId(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new AdminInputError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AdminInputError();
  return parsed;
}

function unavailableAdminApp(): Hono<AdminEnv> {
  const admin = new Hono<AdminEnv>();
  admin.all("*", () => html(unavailableView(), 503));
  return admin;
}

export function createAdminApp(runtime: AdminRuntime): Hono<AdminEnv> {
  // "Is admin configured?" is a fact fixed at process start. Decide it once
  // here; the request paths below can then rely on a token and a registry.
  const bootstrapToken = runtime.bootstrapToken();
  const registry = runtime.registry;
  if (bootstrapToken === undefined || registry === undefined) return unavailableAdminApp();
  const sessions = new AdminSessionManager(bootstrapToken, runtime.now);
  if (!sessions.isConfigured()) return unavailableAdminApp();
  const now = runtime.now ?? Date.now;

  const admin = new Hono<AdminEnv>();

  admin.use(
    "*",
    bodyLimit({
      maxSize: 32 * 1_024,
      onError: (context) => {
        const session = sessions.read(context.req.raw);
        return session === undefined
          ? html(loginView("The submitted form is too large."), 413)
          : html(errorView(session.csrfToken, 413, "The submitted form is too large."), 413);
      },
    }),
  );

  // Every handler below the middleware pair may throw; the mapping from error
  // to page happens exactly once here.
  admin.onError((error, context) => {
    const session = sessions.read(context.req.raw);
    if (session === undefined) return redirect("/admin");
    const status = statusFor(error);
    return html(errorView(session.csrfToken, status, publicMessage(error)), status);
  });

  // The login route is registered before the session middleware: it is the one
  // route a sessionless browser may POST. Failed attempts feed a small
  // fixed-window lockout so the bootstrap token cannot be guessed online at
  // full speed (Control runs as a single replica; the counter is in-process).
  const failedLogins = { count: 0, lockedUntil: 0 };
  admin.post("/login", async (context) => {
    if (now() < failedLogins.lockedUntil) {
      return html(loginView("Too many failed attempts. Try again shortly."), 429);
    }
    let form: FormData;
    try {
      if (!context.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) {
        throw new Error("invalid form content type");
      }
      form = await context.req.formData();
    } catch {
      return html(loginView("The token was not accepted."), 401);
    }
    const token = formText(form, "token");
    if (token === undefined || !sessions.verifyBootstrapToken(token)) {
      failedLogins.count += 1;
      if (failedLogins.count >= LOGIN_LOCKOUT_THRESHOLD) {
        failedLogins.count = 0;
        failedLogins.lockedUntil = now() + LOGIN_LOCKOUT_MS;
      }
      return html(loginView("The token was not accepted."), 401);
    }
    failedLogins.count = 0;
    const created = sessions.create();
    return redirect("/admin", { "set-cookie": created.setCookie });
  });

  // The dashboard root doubles as the sign-in page, so it reads the session
  // itself; it is registered before the session middleware on purpose.
  admin.get("/", async (context) => {
    const session = sessions.read(context.req.raw);
    if (session === undefined) return html(loginView());
    const [spaces, generation] = await Promise.all([
      registry.listSpaces(),
      registry.getGeneration(),
    ]);
    const requested = new URL(context.req.url).searchParams.get("generation");
    const notice = generationNotice(requested, generation.generation);
    const overview: AdminOverview = {
      csrfToken: session.csrfToken,
      generation: generation.generation,
      spaces,
      coverage: deploymentCoverage(spaces, runtime.imgproxyAllowedSources()),
    };
    const edgeRefresh = runtime.edgeRefreshStatus();
    if (edgeRefresh !== undefined) overview.edgeRefresh = edgeRefresh;
    if (notice !== undefined) overview.notice = notice;
    return html(overviewView(overview));
  });

  // Everything after this point holds a verified session.
  admin.use("*", async (context, next) => {
    const session = sessions.read(context.req.raw);
    if (session === undefined) return redirect("/admin");
    context.set("session", session);
    await next();
  });

  // Every POST after this point carries a verified CSRF value from the signed
  // session and an HTTPS same-host Origin.
  admin.use("*", async (context, next) => {
    if (context.req.method !== "POST") return next();
    const session = context.get("session");
    let form: FormData;
    try {
      if (!context.req.header("content-type")?.startsWith("application/x-www-form-urlencoded")) {
        throw new Error("invalid form content type");
      }
      form = await context.req.raw.formData();
    } catch {
      return html(errorView(session.csrfToken, 400, "The submitted form is invalid."), 400);
    }
    if (!sessions.verifyCsrf(context.req.raw, session, formText(form, "csrf"))) {
      return html(errorView(session.csrfToken, 403, "The request could not be verified."), 403);
    }
    context.set("form", form);
    await next();
  });

  admin.post("/logout", async () => {
    return redirect("/admin", { "set-cookie": sessions.clearCookie() });
  });

  admin.post("/spaces", async (context) => {
    const created = await registry.createSpace(parseCreateSpaceForm(context.get("form")));
    return redirect(
      `/admin/spaces/${encodeURIComponent(created.value.policy.id)}?generation=${created.generation}`,
    );
  });

  admin.get("/spaces/:spaceId", async (context) => {
    const session = context.get("session");
    const detail = await loadSpaceDetail(registry, context.req.param("spaceId"));
    const requested = new URL(context.req.url).searchParams.get("generation");
    const notice = generationNotice(requested, detail.generation);
    const model: SpaceDetail = { csrfToken: session.csrfToken, ...detail };
    if (notice !== undefined) model.notice = notice;
    return html(spaceView(model));
  });

  admin.post("/spaces/:spaceId/policy", async (context) => {
    const edited = await registry.editSpace(
      context.req.param("spaceId"),
      parseEditSpaceForm(context.get("form")),
    );
    return redirect(
      `/admin/spaces/${encodeURIComponent(edited.value.policy.id)}?generation=${edited.generation}`,
    );
  });

  admin.post("/spaces/:spaceId/decommission", async (context) => {
    const spaceId = context.req.param("spaceId");
    if (context.get("form").get("confirm") !== spaceId) throw new AdminInputError();
    const decommissioned = await registry.decommissionSpace(spaceId);
    return redirect(`/admin?generation=${decommissioned.generation}`);
  });

  // Both credential routes read the Space detail BEFORE the mutation commits.
  // That order is deliberate and load-bearing: the one-time secret must render
  // even if a registry read after the commit would fail, so no registry read
  // may happen once the credential exists (pinned by ReadFailsAfterIssue tests
  // in admin.test.ts). Do not "simplify" this into mutate-then-re-read.
  admin.post("/spaces/:spaceId/api-tokens", async (context) => {
    const session = context.get("session");
    const label = formText(context.get("form"), "label");
    if (label === undefined) throw new AdminInputError();
    const detail = await loadSpaceDetail(registry, context.req.param("spaceId"));
    const issued = await registry.issueApiToken(context.req.param("spaceId"), label);
    const { token, ...summary } = issued.value;
    return html(
      spaceView({
        csrfToken: session.csrfToken,
        ...detail,
        generation: issued.generation,
        apiTokens: [...detail.apiTokens, summary],
        notice: `The registry is now at generation ${issued.generation}.`,
        secret: { label: "New API token", value: token },
      }),
    );
  });

  admin.post("/spaces/:spaceId/api-tokens/:tokenId/revoke", async (context) => {
    const revoked = await registry.revokeApiToken(
      context.req.param("spaceId"),
      parseTokenId(context.req.param("tokenId")),
    );
    return redirect(
      `/admin/spaces/${encodeURIComponent(context.req.param("spaceId"))}?generation=${revoked.generation}`,
    );
  });

  admin.post("/spaces/:spaceId/capability-keys", async (context) => {
    const session = context.get("session");
    const keyId = formText(context.get("form"), "keyId");
    if (keyId === undefined) throw new AdminInputError();
    const detail = await loadSpaceDetail(registry, context.req.param("spaceId"));
    const issued = await registry.addCapabilityKey(context.req.param("spaceId"), keyId);
    const { key, ...summary } = issued.value;
    return html(
      spaceView({
        csrfToken: session.csrfToken,
        ...detail,
        generation: issued.generation,
        capabilityKeys: [...detail.capabilityKeys, summary],
        notice: `The registry is now at generation ${issued.generation}.`,
        secret: { label: "New Capability Key", value: key },
      }),
    );
  });

  admin.post("/spaces/:spaceId/capability-keys/:keyId/disable", async (context) => {
    const disabled = await registry.disableCapabilityKey(
      context.req.param("spaceId"),
      context.req.param("keyId"),
    );
    return redirect(
      `/admin/spaces/${encodeURIComponent(context.req.param("spaceId"))}?generation=${disabled.generation}`,
    );
  });

  admin.all("*", (context) => {
    const session = context.get("session");
    return html(errorView(session.csrfToken, 404, "The admin page does not exist."), 404);
  });

  return admin;
}
