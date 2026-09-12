import { describe, expect, it } from "vitest";
import {
  ADMIN_SPACE_SCHEMA,
  AdminWireError,
  CREATE_SPACE_REQUEST_SCHEMA,
  ISSUED_API_TOKEN_SCHEMA,
  parseWire,
  RESOLVER_REQUEST_SCHEMA,
} from "./wire.js";

const policy = {
  id: "ernesta",
  routeClass: "public",
  qualities: [75],
  defaultQuality: 75,
  allowedSourceOrigins: [{ origin: "https://uploads.example.test" }],
  resolvers: [],
};

describe("admin wire", () => {
  it("accepts only ISO instants for timestamps", () => {
    const space = {
      policy,
      status: "active",
      createdAt: "2026-09-12T10:00:00.000Z",
      updatedAt: "2026-09-12T10:00:00.000Z",
    };
    expect(parseWire(ADMIN_SPACE_SCHEMA, space).createdAt).toBe("2026-09-12T10:00:00.000Z");
    expect(() =>
      parseWire(ADMIN_SPACE_SCHEMA, { ...space, createdAt: "2026-09-12 10:00" }),
    ).toThrow(AdminWireError);
    expect(() => parseWire(ADMIN_SPACE_SCHEMA, { ...space, extra: 1 })).toThrow(AdminWireError);
  });

  it("turns a create request into a policy and names the first policy issue", () => {
    const { resolvers: _resolvers, ...request } = policy;
    expect(parseWire(CREATE_SPACE_REQUEST_SCHEMA, request)).toMatchObject({
      id: "ernesta",
      resolvers: [],
    });
    expect(() =>
      parseWire(CREATE_SPACE_REQUEST_SCHEMA, { ...request, defaultQuality: 80 }),
    ).toThrow("defaultQuality must be one of the permitted qualities");
    expect(() => parseWire(CREATE_SPACE_REQUEST_SCHEMA, { ...request, resolvers: [] })).toThrow(
      AdminWireError,
    );
  });

  it("parses a resolver request through the protocol schema", () => {
    const parsed = parseWire(RESOLVER_REQUEST_SCHEMA, {
      resolver: {
        id: "media",
        type: "template",
        url: "https://uploads.example.test/{file}",
        placeholders: { file: {} },
      },
    });
    expect(parsed.resolver.type).toBe("template");
    expect(parsed.credential).toBeUndefined();
    expect(() =>
      parseWire(RESOLVER_REQUEST_SCHEMA, {
        resolver: { id: "media", type: "template", url: "https://x/{a}", placeholders: {} },
      }),
    ).toThrow("resolvers[].placeholders must name exactly the placeholders in the url");
  });

  it("requires the secret on an issued credential", () => {
    expect(() =>
      parseWire(ISSUED_API_TOKEN_SCHEMA, {
        generation: 1,
        apiToken: {
          id: 1,
          label: "x",
          displayPrefix: "sk_",
          createdAt: "2026-09-12T10:00:00.000Z",
        },
      }),
    ).toThrow(AdminWireError);
  });
});
