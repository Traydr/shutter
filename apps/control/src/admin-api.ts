/**
 * The `/v1/admin` JSON routes: what the admin application (and any operator
 * script) uses to manage the Space Registry. One machine credential guards
 * them; the operator login lives in the admin application, not here.
 *
 * Two rules from the HTML admin carry over. A credential's secret is answered
 * from the mutation result alone, with no registry read after the commit, so a
 * failing read can never lose a token that was already stored. And a resolver
 * test reports the resolved location by host only.
 */
import {
  ADD_CAPABILITY_KEY_REQUEST_SCHEMA,
  type AdminApiToken,
  type AdminCapabilityKey,
  type AdminOverview,
  type AdminResolverCredential,
  type AdminSpace,
  type AdminSpaceDetail,
  AdminWireError,
  type ApiTokenMutation,
  type CapabilityKeyMutation,
  CREATE_SPACE_REQUEST_SCHEMA,
  ISSUE_API_TOKEN_REQUEST_SCHEMA,
  type IssuedApiToken,
  type IssuedCapabilityKey,
  parseWire,
  RESOLVER_REQUEST_SCHEMA,
  type ResolverRequestParsed,
  type SpaceMutation,
  TEST_RESOLVER_REQUEST_SCHEMA,
  UPDATE_SPACE_POLICY_REQUEST_SCHEMA,
} from "@shutter/admin-api";
import { CONTROL_HTTP_ROUTES, type JsonValue, SpacePolicyValidationError } from "@shutter/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deploymentCoverage } from "./admin/deployment-coverage.js";
import {
  type ResolverTestResult,
  type ResolverTestRuntime,
  testResolver,
} from "./admin/resolver-test.js";
import type { EdgeRefreshStatus } from "./edge-refresh-status.js";
import { bearerAuthorized } from "./origin-auth.js";
import { problemResponse } from "./problems.js";
import {
  type ApiTokenSummary,
  type CapabilityKeySummary,
  type RegistryMutation,
  type ResolverChange,
  type ResolverCredentialSummary,
  type SpaceRecord,
  type SpaceRegistry,
  SpaceRegistryError,
} from "./spaces/registry.js";

export interface AdminApiRuntime extends ResolverTestRuntime {
  /** The `ADMIN_API_TOKEN`; every route answers 401 while it is unset or short. */
  token(): string | undefined;
  registry?: SpaceRegistry | undefined;
  imgproxyAllowedSources(): string | undefined;
  edgeRefreshStatus(): EdgeRefreshStatus | undefined;
  edgeBaseUrl(): string | undefined;
}

type AdminApiEnv = { Variables: { requestId?: string } };

/** The part of a Hono request a JSON body is read from. */
interface JsonRequest {
  header(name: string): string | undefined;
  json(): Promise<JsonValue>;
}

/** Every body an admin route answers 2xx with. */
type AdminResponseBody =
  | AdminOverview
  | AdminSpaceDetail
  | SpaceMutation
  | ResolverTestResult
  | IssuedApiToken
  | ApiTokenMutation
  | IssuedCapabilityKey
  | CapabilityKeyMutation;

const MAX_BODY_BYTES = 32 * 1_024;

const NO_STORE = { "cache-control": "private, no-store" } as const;

// Wire projections: the registry's records with every Date as an ISO instant.

function spaceWire(record: SpaceRecord): AdminSpace {
  const space: AdminSpace = {
    policy: record.policy,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
  if (record.decommissionedAt !== undefined) {
    space.decommissionedAt = record.decommissionedAt.toISOString();
  }
  return space;
}

function apiTokenWire(summary: ApiTokenSummary): AdminApiToken {
  const token: AdminApiToken = {
    id: summary.id,
    label: summary.label,
    displayPrefix: summary.displayPrefix,
    createdAt: summary.createdAt.toISOString(),
  };
  if (summary.lastUsedAt !== undefined) token.lastUsedAt = summary.lastUsedAt.toISOString();
  if (summary.revokedAt !== undefined) token.revokedAt = summary.revokedAt.toISOString();
  return token;
}

function capabilityKeyWire(summary: CapabilityKeySummary): AdminCapabilityKey {
  const key: AdminCapabilityKey = {
    id: summary.id,
    keyId: summary.keyId,
    acceptedAt: summary.acceptedAt.toISOString(),
  };
  if (summary.disabledAt !== undefined) key.disabledAt = summary.disabledAt.toISOString();
  return key;
}

function credentialWire(summary: ResolverCredentialSummary): AdminResolverCredential {
  return {
    resolverId: summary.resolverId,
    accessKeyId: summary.accessKeyId,
    updatedAt: summary.updatedAt.toISOString(),
  };
}

function spaceMutation(mutation: RegistryMutation<SpaceRecord>): SpaceMutation {
  return { generation: mutation.generation, space: spaceWire(mutation.value) };
}

function json(body: AdminResponseBody, status: 200 | 201 = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

// Boundaries

async function readJson(request: JsonRequest): Promise<JsonValue> {
  const contentType = request.header("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new AdminWireError("the request body must be application/json");
  }
  try {
    // The boundary read: the document is untyped until a wire schema parses it.
    return await request.json();
  } catch {
    throw new AdminWireError("the request body is not valid JSON");
  }
}

function tokenIdParam(value: string): number {
  if (!/^[1-9]\d{0,15}$/u.test(value)) {
    throw new AdminWireError("the token identifier must be a positive integer");
  }
  return Number(value);
}

/**
 * The one mapping from a rejected operation to a problem. Anything the
 * registry did not name is a defect and reaches Control's error handler as a
 * 500, never a retryable status.
 */
function problemFor(cause: unknown, requestId: string | undefined): Response | undefined {
  if (cause instanceof AdminWireError || cause instanceof SpacePolicyValidationError) {
    return problemResponse("request_invalid", requestId, cause.message);
  }
  if (cause instanceof SpaceRegistryError) {
    switch (cause.code) {
      case "conflict":
        return problemResponse("conflict", requestId, cause.message);
      case "invalid":
        return problemResponse("request_invalid", requestId, cause.message);
      case "not_found":
        return problemResponse("not_found", requestId, cause.message);
      case "unavailable":
        return problemResponse("service_unavailable", requestId);
    }
  }
  return undefined;
}

async function existingSpace(registry: SpaceRegistry, spaceId: string): Promise<SpaceRecord> {
  const space = await registry.getSpace(spaceId);
  if (space === undefined) throw new SpaceRegistryError("not_found", "the Space does not exist");
  return space;
}

function resolverChange(
  resolverId: string,
  request: ResolverRequestParsed,
  create: boolean,
): ResolverChange {
  const change: ResolverChange = { resolverId, resolver: request.resolver };
  if (create) change.create = true;
  if (request.credential !== undefined) {
    change.credential = { resolverId: request.resolver.id, ...request.credential };
  }
  return change;
}

export function createAdminApi(runtime: AdminApiRuntime): Hono<AdminApiEnv> {
  const admin = new Hono<AdminApiEnv>();
  const routes = CONTROL_HTTP_ROUTES;
  const prefix = `${routes.adminOverview.slice(0, routes.adminOverview.lastIndexOf("/"))}/*`;

  admin.use(prefix, async (context, next) => {
    if (!bearerAuthorized(context.req.header("authorization"), runtime.token())) {
      return problemResponse("unauthorized", context.get("requestId"));
    }
    if (runtime.registry === undefined) {
      return problemResponse("service_unavailable", context.get("requestId"));
    }
    await next();
  });
  admin.use(
    prefix,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (context) => problemResponse("payload_too_large", context.get("requestId")),
    }),
  );
  // Every handler below may throw; the mapping from cause to problem happens
  // once here. A cause the mapping does not name is rethrown to Control's
  // error handler, which logs it and answers 500.
  admin.onError((cause, context) => {
    const response = problemFor(cause, context.get("requestId"));
    if (response === undefined) throw cause;
    return response;
  });

  // Every handler below runs behind the middleware pair, so the registry is present.
  const registry = (): SpaceRegistry => {
    if (runtime.registry === undefined) {
      throw new SpaceRegistryError("unavailable", "the Space Registry is not configured");
    }
    return runtime.registry;
  };

  admin.get(routes.adminOverview, async () => {
    const [spaces, generation] = await Promise.all([
      registry().listSpaces(),
      registry().getGeneration(),
    ]);
    const overview: AdminOverview = {
      generation: generation.generation,
      registryUpdatedAt: generation.updatedAt.toISOString(),
      spaces: spaces.map(spaceWire),
      coverage: deploymentCoverage(spaces, runtime.imgproxyAllowedSources()),
    };
    const refresh = runtime.edgeRefreshStatus();
    if (refresh !== undefined) {
      overview.edgeRefresh = {
        generation: refresh.generation,
        refreshedAt: refresh.refreshedAt.toISOString(),
      };
    }
    const edgeBaseUrl = runtime.edgeBaseUrl();
    if (edgeBaseUrl !== undefined) overview.edgeBaseUrl = edgeBaseUrl;
    return json(overview);
  });

  admin.post(routes.adminSpaces, async (context) => {
    const policy = parseWire(CREATE_SPACE_REQUEST_SCHEMA, await readJson(context.req));
    return json(spaceMutation(await registry().createSpace(policy)), 201);
  });

  admin.get(routes.adminSpace, async (context) => {
    const spaceId = context.req.param("spaceId");
    const [space, generation, apiTokens, capabilityKeys, resolverCredentials] = await Promise.all([
      existingSpace(registry(), spaceId),
      registry().getGeneration(),
      registry().listApiTokens(spaceId),
      registry().listCapabilityKeys(spaceId),
      registry().listResolverCredentials(spaceId),
    ]);
    const detail: AdminSpaceDetail = {
      generation: generation.generation,
      space: spaceWire(space),
      apiTokens: apiTokens.map(apiTokenWire),
      capabilityKeys: capabilityKeys.map(capabilityKeyWire),
      resolverCredentials: resolverCredentials.map(credentialWire),
      coverage: deploymentCoverage([space], runtime.imgproxyAllowedSources()),
    };
    const edgeBaseUrl = runtime.edgeBaseUrl();
    if (edgeBaseUrl !== undefined) detail.edgeBaseUrl = edgeBaseUrl;
    return json(detail);
  });

  admin.put(routes.adminSpacePolicy, async (context) => {
    const update = parseWire(UPDATE_SPACE_POLICY_REQUEST_SCHEMA, await readJson(context.req));
    // Resolvers are absent on purpose: the registry keeps the stored list under its lock.
    const edited = await registry().editSpace(context.req.param("spaceId"), update);
    return json(spaceMutation(edited));
  });

  admin.post(routes.adminSpaceDecommission, async (context) => {
    const decommissioned = await registry().decommissionSpace(context.req.param("spaceId"));
    return json(spaceMutation(decommissioned));
  });

  admin.post(routes.adminResolvers, async (context) => {
    const request = parseWire(RESOLVER_REQUEST_SCHEMA, await readJson(context.req));
    const change = resolverChange(request.resolver.id, request, true);
    const edited = await registry().editResolver(context.req.param("spaceId"), change);
    return json(spaceMutation(edited), 201);
  });

  admin.put(routes.adminResolver, async (context) => {
    const request = parseWire(RESOLVER_REQUEST_SCHEMA, await readJson(context.req));
    // The registry refuses a body whose resolver id differs from the route's.
    const change = resolverChange(context.req.param("resolverId"), request, false);
    const edited = await registry().editResolver(context.req.param("spaceId"), change);
    return json(spaceMutation(edited));
  });

  admin.delete(routes.adminResolver, async (context) => {
    const edited = await registry().editResolver(context.req.param("spaceId"), {
      resolverId: context.req.param("resolverId"),
    });
    return json(spaceMutation(edited));
  });

  admin.post(routes.adminResolverTest, async (context) => {
    const { reference } = parseWire(TEST_RESOLVER_REQUEST_SCHEMA, await readJson(context.req));
    const resolverId = context.req.param("resolverId");
    const space = await existingSpace(registry(), context.req.param("spaceId"));
    if (!space.policy.resolvers.some((resolver) => resolver.id === resolverId)) {
      throw new SpaceRegistryError("not_found", "the resolver does not exist");
    }
    return json(await testResolver(runtime, space, resolverId, reference));
  });

  admin.post(routes.adminApiTokens, async (context) => {
    const { label } = parseWire(ISSUE_API_TOKEN_REQUEST_SCHEMA, await readJson(context.req));
    const issued = await registry().issueApiToken(context.req.param("spaceId"), label);
    const { token, ...summary } = issued.value;
    const body: IssuedApiToken = {
      generation: issued.generation,
      apiToken: apiTokenWire(summary),
      secret: token,
    };
    return json(body, 201);
  });

  admin.post(routes.adminApiTokenRevoke, async (context) => {
    const revoked = await registry().revokeApiToken(
      context.req.param("spaceId"),
      tokenIdParam(context.req.param("tokenId")),
    );
    const body: ApiTokenMutation = {
      generation: revoked.generation,
      apiToken: apiTokenWire(revoked.value),
    };
    return json(body);
  });

  admin.post(routes.adminCapabilityKeys, async (context) => {
    const { keyId } = parseWire(ADD_CAPABILITY_KEY_REQUEST_SCHEMA, await readJson(context.req));
    const issued = await registry().addCapabilityKey(context.req.param("spaceId"), keyId);
    const { key, ...summary } = issued.value;
    const body: IssuedCapabilityKey = {
      generation: issued.generation,
      capabilityKey: capabilityKeyWire(summary),
      secret: key,
    };
    return json(body, 201);
  });

  admin.post(routes.adminCapabilityKeyDisable, async (context) => {
    const disabled = await registry().disableCapabilityKey(
      context.req.param("spaceId"),
      context.req.param("keyId"),
    );
    const body: CapabilityKeyMutation = {
      generation: disabled.generation,
      capabilityKey: capabilityKeyWire(disabled.value),
    };
    return json(body);
  });

  admin.all(prefix, (context) => problemResponse("not_found", context.get("requestId")));

  return admin;
}
