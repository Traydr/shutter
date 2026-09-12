/**
 * Every Control call the pages make, as server functions: the session is
 * checked, the request body is parsed with the wire schema so a rejected
 * input is answered with Control's own message, and the outcome comes back
 * as a result rather than a thrown error so the page can show `detail`.
 */
import {
  ADD_CAPABILITY_KEY_REQUEST_SCHEMA,
  AdminWireError,
  CREATE_SPACE_REQUEST_SCHEMA,
  ISSUE_API_TOKEN_REQUEST_SCHEMA,
  parseWire,
  RESOLVER_REQUEST_SCHEMA,
  TEST_RESOLVER_REQUEST_SCHEMA,
  UPDATE_SPACE_POLICY_REQUEST_SCHEMA,
} from "@shutter/admin-api";
import type { JsonValue } from "@shutter/protocol";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { type ControlResult, controlResult } from "../../server/failure";

const spaceInput = z.object({ spaceId: z.string().min(1) });
const resolverInput = spaceInput.extend({ resolverId: z.string().min(1) });
/** A body the page assembled; the wire schema decides whether it is valid. */
const body = z.json();
const bodyInput = z.object({ body });
const spaceBodyInput = spaceInput.extend({ body });
const resolverBodyInput = resolverInput.extend({ body });

async function server() {
  const [{ control }, { requireSession }] = await Promise.all([
    import("../../server/control"),
    import("../../server/session-guard"),
  ]);
  requireSession();
  return control();
}

/** Parses the body first so a malformed one is a result, not a thrown validation error. */
async function parsedResult<Body, Value>(
  schema: z.ZodType<Body>,
  document: JsonValue,
  work: (parsed: Body) => Promise<Value>,
): Promise<ControlResult<Value>> {
  try {
    return await controlResult(() => work(parseWire(schema, document)));
  } catch (error) {
    if (error instanceof AdminWireError) {
      return {
        ok: false,
        failure: {
          status: 400,
          code: "request_invalid",
          detail: error.message,
          requestId: undefined,
        },
      };
    }
    throw error;
  }
}

export const getOverview = createServerFn({ method: "GET" }).handler(async () => {
  const api = await server();
  return controlResult(() => api.overview());
});

export const getSpace = createServerFn({ method: "GET" })
  .inputValidator(spaceInput)
  .handler(async ({ data }) => {
    const api = await server();
    return controlResult(() => api.space(data.spaceId));
  });

export const createSpace = createServerFn({ method: "POST" })
  .inputValidator(bodyInput)
  .handler(async ({ data }) => {
    const api = await server();
    return parsedResult(CREATE_SPACE_REQUEST_SCHEMA, data.body, (policy) =>
      api.createSpace({
        id: policy.id,
        routeClass: policy.routeClass,
        qualities: [...policy.qualities],
        defaultQuality: policy.defaultQuality,
        allowedSourceOrigins: policy.allowedSourceOrigins.map((rule) => ({ ...rule })),
      }),
    );
  });

export const updateSpacePolicy = createServerFn({ method: "POST" })
  .inputValidator(spaceBodyInput)
  .handler(async ({ data }) => {
    const api = await server();
    return parsedResult(UPDATE_SPACE_POLICY_REQUEST_SCHEMA, data.body, (update) =>
      api.updateSpacePolicy(data.spaceId, {
        qualities: [...update.qualities],
        defaultQuality: update.defaultQuality,
        allowedSourceOrigins: update.allowedSourceOrigins.map((rule) => ({ ...rule })),
      }),
    );
  });

export const decommissionSpace = createServerFn({ method: "POST" })
  .inputValidator(spaceInput)
  .handler(async ({ data }) => {
    const api = await server();
    return controlResult(() => api.decommissionSpace(data.spaceId));
  });

export const createResolver = createServerFn({ method: "POST" })
  .inputValidator(spaceBodyInput)
  .handler(async ({ data }) => {
    const api = await server();
    return parsedResult(RESOLVER_REQUEST_SCHEMA, data.body, (request) =>
      api.createResolver(data.spaceId, request),
    );
  });

export const replaceResolver = createServerFn({ method: "POST" })
  .inputValidator(resolverBodyInput)
  .handler(async ({ data }) => {
    const api = await server();
    return parsedResult(RESOLVER_REQUEST_SCHEMA, data.body, (request) =>
      api.replaceResolver(data.spaceId, data.resolverId, request),
    );
  });

export const removeResolver = createServerFn({ method: "POST" })
  .inputValidator(resolverInput)
  .handler(async ({ data }) => {
    const api = await server();
    return controlResult(() => api.removeResolver(data.spaceId, data.resolverId));
  });

export const testResolver = createServerFn({ method: "POST" })
  .inputValidator(resolverBodyInput)
  .handler(async ({ data }) => {
    const api = await server();
    return parsedResult(TEST_RESOLVER_REQUEST_SCHEMA, data.body, (request) =>
      api.testResolver(data.spaceId, data.resolverId, { reference: [...request.reference] }),
    );
  });

export const issueApiToken = createServerFn({ method: "POST" })
  .inputValidator(spaceBodyInput)
  .handler(async ({ data }) => {
    const api = await server();
    return parsedResult(ISSUE_API_TOKEN_REQUEST_SCHEMA, data.body, (request) =>
      api.issueApiToken(data.spaceId, request),
    );
  });

export const revokeApiToken = createServerFn({ method: "POST" })
  .inputValidator(spaceInput.extend({ tokenId: z.int().positive() }))
  .handler(async ({ data }) => {
    const api = await server();
    return controlResult(() => api.revokeApiToken(data.spaceId, data.tokenId));
  });

export const addCapabilityKey = createServerFn({ method: "POST" })
  .inputValidator(spaceBodyInput)
  .handler(async ({ data }) => {
    const api = await server();
    return parsedResult(ADD_CAPABILITY_KEY_REQUEST_SCHEMA, data.body, (request) =>
      api.addCapabilityKey(data.spaceId, request),
    );
  });

export const disableCapabilityKey = createServerFn({ method: "POST" })
  .inputValidator(spaceInput.extend({ keyId: z.string().min(1) }))
  .handler(async ({ data }) => {
    const api = await server();
    return controlResult(() => api.disableCapabilityKey(data.spaceId, data.keyId));
  });
