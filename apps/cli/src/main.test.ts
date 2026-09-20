import {
  type AdminApiClient,
  AdminApiError,
  type AdminOverview,
  type AdminSpace,
  type AdminSpaceDetail,
} from "@shutter/admin-api";
import { describe, expect, it } from "vitest";
import type { CredentialStore, Credentials, Environment } from "./config.js";
import type { CliContext } from "./context.js";
import { run } from "./main.js";

const AT = "2026-09-20T10:00:00.000Z";
const FILE_CREDENTIALS: Credentials = { url: "https://control.example.test", token: "file-token" };

const SPACE: AdminSpace = {
  policy: {
    id: "ernesta",
    routeClass: "private",
    qualities: [60, 80],
    defaultQuality: 80,
    allowedSourceOrigins: [{ origin: "https://uploads.example.test", pathPrefix: "/f" }],
    resolvers: [
      {
        id: "media",
        type: "template",
        url: "https://uploads.example.test/f/{key}",
        placeholders: { key: {} },
      },
    ],
  },
  status: "active",
  createdAt: AT,
  updatedAt: AT,
};

const MEDIA_STORE = "https://account.r2.example.test/shutter-media";

const OVERVIEW: AdminOverview = {
  generation: 4,
  registryUpdatedAt: AT,
  spaces: [SPACE],
  coverage: {
    derivedValue: `${MEDIA_STORE}/,https://uploads.example.test/f/`,
    uncovered: [MEDIA_STORE],
    mediaStoreSource: MEDIA_STORE,
  },
};

const DETAIL: AdminSpaceDetail = {
  generation: 4,
  space: SPACE,
  apiTokens: [],
  capabilityKeys: [],
  resolverCredentials: [],
  coverage: { derivedValue: "https://uploads.example.test/f/", uncovered: [] },
};

type Call = readonly [method: keyof AdminApiClient, ...args: readonly (string | number | object)[]];

/** An admin client that answers canned documents and records what it was asked. */
function recordingClient(calls: Call[], overview: AdminOverview = OVERVIEW): AdminApiClient {
  const mutation = { generation: 5, space: SPACE };
  const apiToken = { id: 7, label: "web", displayPrefix: "shk_abc", createdAt: AT };
  const capabilityKey = { id: 1, keyId: "k-2026-09", acceptedAt: AT };
  const record = <Answer>(call: Call, answer: Answer): Answer => {
    calls.push(call);
    return answer;
  };
  return {
    overview: async () => record(["overview"], overview),
    space: async (spaceId) => record(["space", spaceId], DETAIL),
    createSpace: async (request) => record(["createSpace", request], mutation),
    updateSpacePolicy: async (spaceId, request) =>
      record(["updateSpacePolicy", spaceId, request], mutation),
    decommissionSpace: async (spaceId) => record(["decommissionSpace", spaceId], mutation),
    createResolver: async (spaceId, request) =>
      record(["createResolver", spaceId, request], mutation),
    replaceResolver: async (spaceId, resolverId, request) =>
      record(["replaceResolver", spaceId, resolverId, request], mutation),
    removeResolver: async (spaceId, resolverId) =>
      record(["removeResolver", spaceId, resolverId], mutation),
    testResolver: async (spaceId, resolverId, request) =>
      record(["testResolver", spaceId, resolverId, request], {
        outcome: "failed",
        message: "the location answered 404",
        status: 404,
      }),
    issueApiToken: async (spaceId, request) =>
      record(["issueApiToken", spaceId, request], {
        generation: 5,
        apiToken,
        secret: "shk_secret",
      }),
    revokeApiToken: async (spaceId, tokenId) =>
      record(["revokeApiToken", spaceId, tokenId], { generation: 5, apiToken }),
    addCapabilityKey: async (spaceId, request) =>
      record(["addCapabilityKey", spaceId, request], {
        generation: 5,
        capabilityKey,
        secret: "key_secret",
      }),
    disableCapabilityKey: async (spaceId, keyId) =>
      record(["disableCapabilityKey", spaceId, keyId], { generation: 5, capabilityKey }),
  };
}

interface Harness {
  context: CliContext;
  calls: Call[];
  connected: Credentials[];
  stdout: string[];
  stderr: string[];
  stored(): Credentials | null;
}

interface HarnessOptions {
  env?: Environment;
  stored?: Credentials | null;
  client?: AdminApiClient;
  input?: string;
}

function harness(options: HarnessOptions = {}): Harness {
  let stored = options.stored === undefined ? FILE_CREDENTIALS : options.stored;
  const calls: Call[] = [];
  const connected: Credentials[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const credentials: CredentialStore = {
    path: () => "/config/shutter/credentials",
    read: async () => stored,
    write: async (next) => {
      stored = next;
    },
    remove: async () => {
      const had = stored !== null;
      stored = null;
      return had;
    },
  };
  const client = options.client ?? recordingClient(calls);
  return {
    calls,
    connected,
    stdout,
    stderr,
    stored: () => stored,
    context: {
      env: options.env ?? {},
      output: { out: (line) => stdout.push(line), err: (line) => stderr.push(line) },
      credentials,
      connect: ({ url, token }) => {
        connected.push({ url, token });
        return client;
      },
      readInput: async () => options.input ?? "",
      prompt: async () => "",
    },
  };
}

describe("shutter CLI", () => {
  it("resolves credentials from flags, then the environment, then the file", async () => {
    const file = harness();
    expect(await run(["space", "ls"], file.context)).toBe(0);
    expect(file.connected).toEqual([FILE_CREDENTIALS]);

    const env = harness({ env: { SHUTTER_TOKEN: "env-token" } });
    await run(["space", "ls", "--url", "https://flag.example.test/"], env.context);
    expect(env.connected).toEqual([{ url: "https://flag.example.test", token: "env-token" }]);

    const none = harness({ stored: null });
    expect(await run(["space", "ls"], none.context)).toBe(1);
    expect(none.stderr.join("\n")).toContain("not logged in");
  });

  it("stores credentials only after Control accepts them", async () => {
    const accepted = harness({ stored: null });
    const login = ["auth", "login", "--url", "https://control.example.test/", "--token", "t"];
    expect(await run(login, accepted.context)).toBe(0);
    expect(accepted.stored()).toEqual({ url: "https://control.example.test", token: "t" });

    const rejecting: AdminApiClient = {
      ...recordingClient([]),
      overview: async () => {
        throw new AdminApiError("the credential is not valid", {
          status: 401,
          code: "unauthorized",
        });
      },
    };
    const refused = harness({ stored: null, client: rejecting });
    expect(await run(login, refused.context)).toBe(1);
    expect(refused.stored()).toBeNull();
    expect(refused.stderr).toEqual(["error: unauthorized: the credential is not valid"]);
  });

  it("prints the derived allowlist, and fails --check while an entry is undeployed", async () => {
    const printed = harness();
    expect(await run(["allowlist"], printed.context)).toBe(0);
    expect(printed.stdout).toEqual([OVERVIEW.coverage.derivedValue]);
    expect(printed.stderr.join("\n")).toContain(MEDIA_STORE);

    const checked = harness();
    expect(await run(["allowlist", "--check"], checked.context)).toBe(1);
    expect(checked.stdout).toEqual([OVERVIEW.coverage.derivedValue]);
  });

  it("creates a Space from flags", async () => {
    const cli = harness();
    const code = await run(
      [
        "space",
        "create",
        "latch",
        "--route-class",
        "public",
        "--origin",
        "https://uploads.example.test/f/",
        "--origin",
        "https://cdn.example.test",
      ],
      cli.context,
    );
    expect(code).toBe(0);
    expect(cli.calls).toEqual([
      [
        "createSpace",
        {
          id: "latch",
          routeClass: "public",
          qualities: [60, 80],
          defaultQuality: 80,
          allowedSourceOrigins: [
            { origin: "https://uploads.example.test", pathPrefix: "/f/" },
            { origin: "https://cdn.example.test" },
          ],
        },
      ],
    ]);
  });

  it("updates only the policy fields it was given", async () => {
    const cli = harness();
    expect(await run(["space", "update", "ernesta", "--qualities", "50,70,90"], cli.context)).toBe(
      0,
    );
    expect(cli.calls.at(-1)).toEqual([
      "updateSpacePolicy",
      "ernesta",
      {
        qualities: [50, 70, 90],
        defaultQuality: 80,
        allowedSourceOrigins: SPACE.policy.allowedSourceOrigins,
      },
    ]);
    expect(await run(["space", "update", "ernesta"], harness().context)).toBe(1);
  });

  it("replaces a resolver the Space has and creates one it lacks", async () => {
    const resolver = (id: string) =>
      JSON.stringify({
        resolver: {
          id,
          type: "template",
          url: "https://uploads.example.test/f/{key}",
          placeholders: { key: {} },
        },
      });
    const replaced = harness({ input: resolver("media") });
    expect(await run(["resolver", "set", "ernesta", "--file", "-"], replaced.context)).toBe(0);
    expect(replaced.calls.at(-1)?.slice(0, 3)).toEqual(["replaceResolver", "ernesta", "media"]);

    const created = harness({ input: resolver("archive") });
    expect(await run(["resolver", "set", "ernesta", "--file", "-"], created.context)).toBe(0);
    expect(created.calls.at(-1)?.slice(0, 2)).toEqual(["createResolver", "ernesta"]);

    const invalid = harness({ input: "{" });
    expect(await run(["resolver", "set", "ernesta", "--file", "-"], invalid.context)).toBe(1);
    expect(invalid.calls).toEqual([]);
  });

  it("puts an issued secret alone on stdout", async () => {
    const token = harness();
    expect(await run(["token", "issue", "ernesta", "--label", "web"], token.context)).toBe(0);
    expect(token.stdout).toEqual(["shk_secret"]);

    const key = harness();
    expect(await run(["key", "add", "ernesta", "k-2026-09"], key.context)).toBe(0);
    expect(key.stdout).toEqual(["key_secret"]);
  });

  it("refuses a destructive command without --yes", async () => {
    for (const argv of [
      ["space", "decommission", "ernesta"],
      ["resolver", "rm", "ernesta", "media"],
      ["key", "disable", "ernesta", "k-2026-09"],
    ]) {
      const refused = harness();
      expect(await run(argv, refused.context)).toBe(1);
      expect(refused.calls).toEqual([]);
      const confirmed = harness();
      expect(await run([...argv, "--yes"], confirmed.context)).toBe(0);
      expect(confirmed.calls).toHaveLength(1);
    }
  });

  it("exits 1 when a resolver test fails", async () => {
    const cli = harness();
    expect(await run(["resolver", "test", "ernesta", "media", "abc", "def"], cli.context)).toBe(1);
    expect(cli.calls).toEqual([
      ["testResolver", "ernesta", "media", { reference: ["abc", "def"] }],
    ]);
    expect(cli.stdout).toEqual(["failed: the location answered 404 (404)"]);
  });
});
