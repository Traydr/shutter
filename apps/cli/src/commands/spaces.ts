import type {
  AdminSpace,
  AdminSpaceDetail,
  CreateSpaceRequest,
  UpdateSpacePolicyRequest,
} from "@shutter/admin-api";
import type { Command } from "../context.js";
import { CliError, table } from "../io.js";

type SourceOriginInput = CreateSpaceRequest["allowedSourceOrigins"][number];

/** `https://host[/path-prefix]` as the allowed-origin rule it names. */
export function sourceOriginRule(value: string): SourceOriginInput {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError(`--origin must be an HTTPS URL such as https://uploads.example.com/f/`);
  }
  const rule: SourceOriginInput = { origin: url.origin };
  if (url.pathname !== "/") rule.pathPrefix = url.pathname;
  return rule;
}

function integers(flag: string, value: string): number[] {
  const parsed = value.split(",").map((entry) => Number(entry.trim()));
  if (parsed.some((entry) => !Number.isInteger(entry))) {
    throw new CliError(`${flag} must be integers, such as 60,80`);
  }
  return parsed;
}

function originText(rule: SourceOriginInput): string {
  return `${rule.origin}${rule.pathPrefix ?? ""}`;
}

function describeSpace(space: AdminSpace): string[][] {
  const { policy } = space;
  return [
    ["Space", policy.id],
    ["Status", space.status],
    ["Route class", policy.routeClass],
    ["Qualities", `${policy.qualities.join(", ")} (default ${policy.defaultQuality})`],
    ["Origins", policy.allowedSourceOrigins.map(originText).join(", ")],
    [
      "Resolvers",
      policy.resolvers.map((resolver) => `${resolver.id} (${resolver.type})`).join(", ") || "none",
    ],
    ["Updated", space.updatedAt],
  ];
}

function describeDetail(detail: AdminSpaceDetail): string[][] {
  const tokens = detail.apiTokens.filter((token) => token.revokedAt === undefined);
  const keys = detail.capabilityKeys.filter((key) => key.disabledAt === undefined);
  return [
    ...describeSpace(detail.space),
    ["API tokens", tokens.map((token) => `#${token.id} ${token.label}`).join(", ") || "none"],
    ["Capability keys", keys.map((key) => key.keyId).join(", ") || "none"],
    [
      "S3 credentials",
      detail.resolverCredentials.map((entry) => entry.resolverId).join(", ") || "none",
    ],
    ["Not in imgproxy", detail.coverage.uncovered.join(", ") || "none"],
    ["Generation", String(detail.generation)],
  ];
}

export async function overview({ client, output, flags }: Command): Promise<void> {
  const document = await client.overview();
  if (flags.json) return output.out(JSON.stringify(document, null, 2));
  output.out(`Generation ${document.generation}, registry updated ${document.registryUpdatedAt}`);
  if (document.edgeBaseUrl !== undefined) output.out(`Edge ${document.edgeBaseUrl}`);
  if (document.edgeRefresh !== undefined) {
    output.out(
      `Edge read generation ${document.edgeRefresh.generation} at ${document.edgeRefresh.refreshedAt}`,
    );
  }
  const uncovered = document.coverage.uncovered;
  output.out(
    uncovered.length === 0
      ? "imgproxy allowlist covers everything"
      : `imgproxy allowlist is missing: ${uncovered.join(", ")} (see \`shutter allowlist\`)`,
  );
  output.out("");
  await list({ client, output, flags });
}

export async function list({ client, output, flags }: Command): Promise<void> {
  const { spaces } = await client.overview();
  if (flags.json) return output.out(JSON.stringify(spaces, null, 2));
  if (spaces.length === 0) return output.out("No Spaces.");
  output.out(
    table([
      ["SPACE", "STATUS", "ROUTE", "RESOLVERS", "ORIGINS"],
      ...spaces.map((space) => [
        space.policy.id,
        space.status,
        space.policy.routeClass,
        space.policy.resolvers.map((resolver) => resolver.id).join(",") || "-",
        space.policy.allowedSourceOrigins.map(originText).join(","),
      ]),
    ]),
  );
}

export async function get({ client, output, flags }: Command, spaceId: string): Promise<void> {
  const detail = await client.space(spaceId);
  output.out(flags.json ? JSON.stringify(detail, null, 2) : table(describeDetail(detail)));
}

export async function create(command: Command, spaceId: string): Promise<void> {
  const { client, output, flags } = command;
  if (flags.routeClass === undefined)
    throw new CliError("--route-class public|private is required");
  if (flags.origins.length === 0) throw new CliError("at least one --origin is required");
  const qualities = integers("--qualities", flags.qualities ?? "60,80");
  const created = await client.createSpace({
    id: spaceId,
    routeClass: flags.routeClass,
    qualities,
    defaultQuality:
      flags.defaultQuality === undefined ? Math.max(...qualities) : Number(flags.defaultQuality),
    allowedSourceOrigins: flags.origins.map(sourceOriginRule),
  });
  output.out(flags.json ? JSON.stringify(created, null, 2) : table(describeSpace(created.space)));
}

/** Changes only the policy fields whose flags were given; the rest keep their stored values. */
export async function update(command: Command, spaceId: string): Promise<void> {
  const { client, output, flags } = command;
  if (
    flags.origins.length === 0 &&
    flags.qualities === undefined &&
    flags.defaultQuality === undefined
  ) {
    throw new CliError("nothing to change: pass --origin, --qualities, or --default-quality");
  }
  const { policy } = (await client.space(spaceId)).space;
  const request: UpdateSpacePolicyRequest = {
    qualities:
      flags.qualities === undefined ? policy.qualities : integers("--qualities", flags.qualities),
    defaultQuality:
      flags.defaultQuality === undefined ? policy.defaultQuality : Number(flags.defaultQuality),
    allowedSourceOrigins:
      flags.origins.length === 0
        ? policy.allowedSourceOrigins
        : flags.origins.map(sourceOriginRule),
  };
  const updated = await client.updateSpacePolicy(spaceId, request);
  output.out(flags.json ? JSON.stringify(updated, null, 2) : table(describeSpace(updated.space)));
}

export async function decommission(command: Command, spaceId: string): Promise<void> {
  const { client, output, flags } = command;
  if (!flags.yes) {
    throw new CliError(
      `decommissioning ${spaceId} is permanent and its identifier is never reused; pass --yes to confirm`,
    );
  }
  const result = await client.decommissionSpace(spaceId);
  output.out(flags.json ? JSON.stringify(result, null, 2) : `Decommissioned ${spaceId}.`);
}

/** Prints the derived `IMGPROXY_ALLOWED_SOURCES`; answers whether the deployed value covers it. */
export async function allowlist({ client, output, flags }: Command): Promise<boolean> {
  const { coverage } = await client.overview();
  if (flags.json) output.out(JSON.stringify(coverage, null, 2));
  else output.out(coverage.derivedValue);
  if (coverage.uncovered.length === 0) return true;
  output.err(`not in the deployed IMGPROXY_ALLOWED_SOURCES: ${coverage.uncovered.join(", ")}`);
  return !flags.check;
}
