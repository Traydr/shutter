import { SpacePolicyValidationError } from "@shutter/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { EdgeRefreshStatus } from "../edge-refresh-status.js";
import { type SpaceRecord, type SpaceRegistry, SpaceRegistryError } from "../spaces/registry.js";
import { deploymentCoverage } from "./deployment-coverage.js";
import { AdminInputError, parseCreateSpaceForm, parseEditSpaceForm } from "./input.js";
import { type AdminSession, AdminSessionManager } from "./session.js";
import { errorView, loginView, overviewView, spaceView, unavailableView } from "./view.js";

export interface AdminRuntime {
  bootstrapToken(): string | undefined;
  imgproxyAllowedSources(): string | undefined;
  registry?: SpaceRegistry;
  edgeRefreshStatus(): EdgeRefreshStatus | undefined;
  now?(): number;
}

interface MutationRequest {
  form: FormData;
  registry: SpaceRegistry;
  session: AdminSession;
}

function html(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=UTF-8",
      "referrer-policy": "no-referrer",
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

function manager(runtime: AdminRuntime): AdminSessionManager | undefined {
  const token = runtime.bootstrapToken();
  if (token === undefined) return undefined;
  const sessions = new AdminSessionManager(token, runtime.now);
  return sessions.isConfigured() ? sessions : undefined;
}

function authenticated(
  request: Request,
  runtime: AdminRuntime,
): { manager: AdminSessionManager; session: AdminSession } | undefined {
  const sessions = manager(runtime);
  const session = sessions?.read(request);
  return sessions === undefined || session === undefined
    ? undefined
    : { manager: sessions, session };
}

async function mutation(
  request: Request,
  runtime: AdminRuntime,
): Promise<MutationRequest | Response> {
  const auth = authenticated(request, runtime);
  if (auth === undefined) return redirect("/admin");
  if (runtime.registry === undefined) return html(unavailableView(), 503);
  let form: FormData;
  try {
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
      throw new Error("invalid form content type");
    }
    form = await request.formData();
  } catch {
    return html(errorView(auth.session.csrfToken, 400, "The submitted form is invalid."), 400);
  }
  if (!auth.manager.verifyCsrf(request, auth.session, form.get("csrf"))) {
    return html(errorView(auth.session.csrfToken, 403, "The request could not be verified."), 403);
  }
  return { form, registry: runtime.registry, session: auth.session };
}

function statusFor(error: unknown): number {
  if (error instanceof AdminInputError || error instanceof SpacePolicyValidationError) return 400;
  if (error instanceof SpaceRegistryError) {
    if (error.code === "not_found") return 404;
    if (error.code === "unavailable") return 503;
    return 400;
  }
  return 503;
}

function publicMessage(error: unknown): string {
  if (error instanceof SpaceRegistryError) return error.message;
  if (error instanceof AdminInputError || error instanceof SpacePolicyValidationError) {
    return "The submitted values are not valid.";
  }
  return "The Space Registry is unavailable.";
}

async function runMutation(
  request: Request,
  runtime: AdminRuntime,
  command: (input: MutationRequest) => Promise<Response>,
): Promise<Response> {
  const input = await mutation(request, runtime);
  if (input instanceof Response) return input;
  try {
    return await command(input);
  } catch (error) {
    const status = statusFor(error);
    return html(errorView(input.session.csrfToken, status, publicMessage(error)), status);
  }
}

async function currentSpace(registry: SpaceRegistry, spaceId: string): Promise<SpaceRecord> {
  const space = (await registry.listSpaces()).find((candidate) => candidate.policy.id === spaceId);
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

async function renderSpace(
  registry: SpaceRegistry,
  spaceId: string,
  csrfToken: string,
  options: {
    notice?: string;
    secret?: { label: string; value: string };
  } = {},
): Promise<Response> {
  const detail = await loadSpaceDetail(registry, spaceId);
  return html(
    spaceView({
      csrfToken,
      ...detail,
      ...options,
    }),
  );
}

function parseTokenId(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new AdminInputError();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AdminInputError();
  return parsed;
}

export function createAdminApp(runtime: AdminRuntime): Hono {
  const admin = new Hono();

  admin.use(
    "*",
    bodyLimit({
      maxSize: 32 * 1_024,
      onError: () => html(loginView("The submitted form is too large."), 413),
    }),
  );

  admin.get("/", async (context) => {
    const sessions = manager(runtime);
    if (sessions === undefined || runtime.registry === undefined) {
      return html(unavailableView(), 503);
    }
    const session = sessions.read(context.req.raw);
    if (session === undefined) return html(loginView());
    try {
      const [spaces, generation] = await Promise.all([
        runtime.registry.listSpaces(),
        runtime.registry.getGeneration(),
      ]);
      const requestedGeneration = new URL(context.req.url).searchParams.get("generation");
      const notice =
        requestedGeneration !== null && /^\d+$/u.test(requestedGeneration)
          ? `The registry is now at generation ${requestedGeneration}.`
          : undefined;
      const edgeRefresh = runtime.edgeRefreshStatus();
      return html(
        overviewView({
          csrfToken: session.csrfToken,
          generation: generation.generation,
          spaces,
          coverage: deploymentCoverage(spaces, runtime.imgproxyAllowedSources()),
          ...(edgeRefresh === undefined ? {} : { edgeRefresh }),
          ...(notice === undefined ? {} : { notice }),
        }),
      );
    } catch {
      return html(errorView(session.csrfToken, 503, "The Space Registry is unavailable."), 503);
    }
  });

  admin.post("/login", async (context) => {
    const sessions = manager(runtime);
    if (sessions === undefined || runtime.registry === undefined) {
      return html(unavailableView(), 503);
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
    const token = form.get("token");
    if (typeof token !== "string" || !sessions.verifyBootstrapToken(token)) {
      return html(loginView("The token was not accepted."), 401);
    }
    const created = sessions.create();
    return redirect("/admin", { "set-cookie": created.setCookie });
  });

  admin.post("/logout", async (context) => {
    const result = await mutation(context.req.raw, runtime);
    if (result instanceof Response) return result;
    const sessions = manager(runtime);
    return redirect("/admin", { "set-cookie": sessions?.clearCookie() ?? "" });
  });

  admin.post("/spaces", async (context) => {
    return runMutation(context.req.raw, runtime, async ({ form, registry }) => {
      const created = await registry.createSpace(parseCreateSpaceForm(form));
      return redirect(
        `/admin/spaces/${encodeURIComponent(created.value.policy.id)}?generation=${created.generation}`,
      );
    });
  });

  admin.get("/spaces/:spaceId", async (context) => {
    const auth = authenticated(context.req.raw, runtime);
    if (auth === undefined) return redirect("/admin");
    if (runtime.registry === undefined) return html(unavailableView(), 503);
    try {
      const requestedGeneration = new URL(context.req.url).searchParams.get("generation");
      return await renderSpace(
        runtime.registry,
        context.req.param("spaceId"),
        auth.session.csrfToken,
        {
          ...(requestedGeneration !== null && /^\d+$/u.test(requestedGeneration)
            ? { notice: `The registry is now at generation ${requestedGeneration}.` }
            : {}),
        },
      );
    } catch (error) {
      const status = statusFor(error);
      return html(errorView(auth.session.csrfToken, status, publicMessage(error)), status);
    }
  });

  admin.post("/spaces/:spaceId/policy", async (context) => {
    return runMutation(context.req.raw, runtime, async ({ form, registry }) => {
      const edited = await registry.editSpace(
        context.req.param("spaceId"),
        parseEditSpaceForm(form),
      );
      return redirect(
        `/admin/spaces/${encodeURIComponent(edited.value.policy.id)}?generation=${edited.generation}`,
      );
    });
  });

  admin.post("/spaces/:spaceId/decommission", async (context) => {
    return runMutation(context.req.raw, runtime, async ({ form, registry }) => {
      const spaceId = context.req.param("spaceId");
      if (form.get("confirm") !== spaceId) throw new AdminInputError();
      const decommissioned = await registry.decommissionSpace(spaceId);
      return redirect(`/admin?generation=${decommissioned.generation}`);
    });
  });

  admin.post("/spaces/:spaceId/api-tokens", async (context) => {
    return runMutation(context.req.raw, runtime, async ({ form, registry, session }) => {
      const label = form.get("label");
      if (typeof label !== "string") throw new AdminInputError();
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
  });

  admin.post("/spaces/:spaceId/api-tokens/:tokenId/revoke", async (context) => {
    return runMutation(context.req.raw, runtime, async ({ registry }) => {
      const revoked = await registry.revokeApiToken(
        context.req.param("spaceId"),
        parseTokenId(context.req.param("tokenId")),
      );
      return redirect(
        `/admin/spaces/${encodeURIComponent(context.req.param("spaceId"))}?generation=${revoked.generation}`,
      );
    });
  });

  admin.post("/spaces/:spaceId/capability-keys", async (context) => {
    return runMutation(context.req.raw, runtime, async ({ form, registry, session }) => {
      const keyId = form.get("keyId");
      if (typeof keyId !== "string") throw new AdminInputError();
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
  });

  admin.post("/spaces/:spaceId/capability-keys/:keyId/disable", async (context) => {
    return runMutation(context.req.raw, runtime, async ({ registry }) => {
      const disabled = await registry.disableCapabilityKey(
        context.req.param("spaceId"),
        context.req.param("keyId"),
      );
      return redirect(
        `/admin/spaces/${encodeURIComponent(context.req.param("spaceId"))}?generation=${disabled.generation}`,
      );
    });
  });

  admin.all("*", (context) => {
    const auth = authenticated(context.req.raw, runtime);
    if (auth === undefined) return redirect("/admin");
    return html(errorView(auth.session.csrfToken, 404, "The admin page does not exist."), 404);
  });

  return admin;
}
