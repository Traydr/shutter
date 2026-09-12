import { CONTROL_HTTP_ROUTES, type JsonValue } from "@shutter/protocol";
import type { z } from "zod";
import {
  ADMIN_OVERVIEW_SCHEMA,
  ADMIN_PROBLEM_SCHEMA,
  ADMIN_SPACE_DETAIL_SCHEMA,
  type AddCapabilityKeyRequest,
  type AdminOverview,
  type AdminSpaceDetail,
  API_TOKEN_MUTATION_SCHEMA,
  type ApiTokenMutation,
  CAPABILITY_KEY_MUTATION_SCHEMA,
  type CapabilityKeyMutation,
  type CreateSpaceRequest,
  ISSUED_API_TOKEN_SCHEMA,
  ISSUED_CAPABILITY_KEY_SCHEMA,
  type IssueApiTokenRequest,
  type IssuedApiToken,
  type IssuedCapabilityKey,
  parseWire,
  RESOLVER_TEST_RESULT_SCHEMA,
  type ResolverRequest,
  type ResolverTestResultWire,
  SPACE_MUTATION_SCHEMA,
  type SpaceMutation,
  type TestResolverRequest,
  type UpdateSpacePolicyRequest,
} from "./wire.js";

export interface AdminApiClientConfig {
  /** Control's origin, such as `https://shutter-control.example.com`. */
  baseUrl: string;
  /** The `ADMIN_API_TOKEN` Control was deployed with. */
  token: string;
  /** Per-request timeout in milliseconds. Defaults to 10000. */
  requestTimeoutMs?: number | undefined;
  /** Fetch implementation override, mainly for tests. */
  fetch?: typeof globalThis.fetch | undefined;
}

/**
 * A failed admin call. `code` is the problem code Control answered with, or
 * `transport` when no problem document arrived at all.
 */
export class AdminApiError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  readonly detail: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    fields: {
      status?: number | undefined;
      code: string;
      detail?: string | undefined;
      requestId?: string | undefined;
    },
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "AdminApiError";
    this.status = fields.status;
    this.code = fields.code;
    this.detail = fields.detail;
    this.requestId = fields.requestId;
  }
}

/** The bodies the client sends; Control validates them, so the client sends them as typed. */
type RequestBody =
  | CreateSpaceRequest
  | UpdateSpacePolicyRequest
  | ResolverRequest
  | TestResolverRequest
  | IssueApiTokenRequest
  | AddCapabilityKeyRequest;

function fill(route: string, params: Readonly<Record<string, string>>): string {
  return route.replace(/:([A-Za-z]+)/gu, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : encodeURIComponent(value);
  });
}

export interface AdminApiClient {
  overview(): Promise<AdminOverview>;
  createSpace(request: CreateSpaceRequest): Promise<SpaceMutation>;
  space(spaceId: string): Promise<AdminSpaceDetail>;
  updateSpacePolicy(spaceId: string, request: UpdateSpacePolicyRequest): Promise<SpaceMutation>;
  decommissionSpace(spaceId: string): Promise<SpaceMutation>;
  createResolver(spaceId: string, request: ResolverRequest): Promise<SpaceMutation>;
  replaceResolver(
    spaceId: string,
    resolverId: string,
    request: ResolverRequest,
  ): Promise<SpaceMutation>;
  removeResolver(spaceId: string, resolverId: string): Promise<SpaceMutation>;
  testResolver(
    spaceId: string,
    resolverId: string,
    request: TestResolverRequest,
  ): Promise<ResolverTestResultWire>;
  issueApiToken(spaceId: string, request: IssueApiTokenRequest): Promise<IssuedApiToken>;
  revokeApiToken(spaceId: string, tokenId: number): Promise<ApiTokenMutation>;
  addCapabilityKey(spaceId: string, request: AddCapabilityKeyRequest): Promise<IssuedCapabilityKey>;
  disableCapabilityKey(spaceId: string, keyId: string): Promise<CapabilityKeyMutation>;
}

export function createAdminApiClient(config: AdminApiClientConfig): AdminApiClient {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const baseUrl = config.baseUrl.replace(/\/+$/u, "");

  async function call<Schema extends z.ZodType>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    schema: Schema,
    body?: RequestBody,
  ): Promise<z.output<Schema>> {
    const headers = new Headers({
      authorization: `Bearer ${config.token}`,
      accept: "application/json, application/problem+json",
    });
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      headers.set("content-type", "application/json");
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, init);
    } catch (error) {
      throw new AdminApiError("Control could not be reached", { code: "transport" }, error);
    }
    let document: JsonValue;
    try {
      document = await response.json();
    } catch (error) {
      throw new AdminApiError(
        `Control answered ${response.status} without a JSON body`,
        { status: response.status, code: "transport" },
        error,
      );
    }
    if (!response.ok) {
      const problem = ADMIN_PROBLEM_SCHEMA.safeParse(document);
      if (!problem.success) {
        throw new AdminApiError(`Control answered ${response.status}`, {
          status: response.status,
          code: "transport",
        });
      }
      throw new AdminApiError(problem.data.detail ?? problem.data.title, {
        status: problem.data.status,
        code: problem.data.code,
        detail: problem.data.detail,
        requestId: problem.data.requestId,
      });
    }
    try {
      return parseWire(schema, document);
    } catch (error) {
      throw new AdminApiError(
        `Control answered ${response.status} with a document this client does not understand`,
        { status: response.status, code: "transport" },
        error,
      );
    }
  }

  const routes = CONTROL_HTTP_ROUTES;
  return {
    overview: () => call("GET", routes.adminOverview, ADMIN_OVERVIEW_SCHEMA),
    createSpace: (request) => call("POST", routes.adminSpaces, SPACE_MUTATION_SCHEMA, request),
    space: (spaceId) =>
      call("GET", fill(routes.adminSpace, { spaceId }), ADMIN_SPACE_DETAIL_SCHEMA),
    updateSpacePolicy: (spaceId, request) =>
      call("PUT", fill(routes.adminSpacePolicy, { spaceId }), SPACE_MUTATION_SCHEMA, request),
    decommissionSpace: (spaceId) =>
      call("POST", fill(routes.adminSpaceDecommission, { spaceId }), SPACE_MUTATION_SCHEMA),
    createResolver: (spaceId, request) =>
      call("POST", fill(routes.adminResolvers, { spaceId }), SPACE_MUTATION_SCHEMA, request),
    replaceResolver: (spaceId, resolverId, request) =>
      call(
        "PUT",
        fill(routes.adminResolver, { spaceId, resolverId }),
        SPACE_MUTATION_SCHEMA,
        request,
      ),
    removeResolver: (spaceId, resolverId) =>
      call("DELETE", fill(routes.adminResolver, { spaceId, resolverId }), SPACE_MUTATION_SCHEMA),
    testResolver: (spaceId, resolverId, request) =>
      call(
        "POST",
        fill(routes.adminResolverTest, { spaceId, resolverId }),
        RESOLVER_TEST_RESULT_SCHEMA,
        request,
      ),
    issueApiToken: (spaceId, request) =>
      call("POST", fill(routes.adminApiTokens, { spaceId }), ISSUED_API_TOKEN_SCHEMA, request),
    revokeApiToken: (spaceId, tokenId) =>
      call(
        "POST",
        fill(routes.adminApiTokenRevoke, { spaceId, tokenId: String(tokenId) }),
        API_TOKEN_MUTATION_SCHEMA,
      ),
    addCapabilityKey: (spaceId, request) =>
      call(
        "POST",
        fill(routes.adminCapabilityKeys, { spaceId }),
        ISSUED_CAPABILITY_KEY_SCHEMA,
        request,
      ),
    disableCapabilityKey: (spaceId, keyId) =>
      call(
        "POST",
        fill(routes.adminCapabilityKeyDisable, { spaceId, keyId }),
        CAPABILITY_KEY_MUTATION_SCHEMA,
      ),
  };
}
