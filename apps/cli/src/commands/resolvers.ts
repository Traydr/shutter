import { RESOLVER_REQUEST_SCHEMA } from "@shutter/admin-api";
import type { JsonValue, SourceResolverPolicy } from "@shutter/protocol";
import type { Command } from "../context.js";
import { CliError, table } from "../io.js";

/**
 * The resolver document `resolver set` reads: `{ "resolver": {...} }`, plus
 * `"credential": { "accessKeyId", "secretAccessKey" }` for an `s3` resolver.
 */
function resolverRequest(text: string) {
  let document: JsonValue;
  try {
    // The boundary read: the document is untyped until the wire schema parses it.
    document = JSON.parse(text);
  } catch {
    throw new CliError("the resolver document is not valid JSON");
  }
  const parsed = RESOLVER_REQUEST_SCHEMA.safeParse(document);
  if (!parsed.success) {
    throw new CliError(parsed.error.issues[0]?.message ?? "the resolver document is not valid");
  }
  return parsed.data;
}

function resolverTarget(resolver: SourceResolverPolicy): string {
  switch (resolver.type) {
    case "template":
      return resolver.url;
    case "s3":
      return `${resolver.endpoint}/${resolver.bucket}/${resolver.keyTemplate}`;
    case "uploadthing":
      return resolver.allowedProjectIds.join(",");
  }
}

export async function list({ client, output, flags }: Command, spaceId: string): Promise<void> {
  const detail = await client.space(spaceId);
  const { resolvers } = detail.space.policy;
  if (flags.json) return output.out(JSON.stringify(resolvers, null, 2));
  if (resolvers.length === 0) return output.out("No resolvers.");
  output.out(
    table([
      ["RESOLVER", "TYPE", "TARGET"],
      ...resolvers.map((resolver) => [resolver.id, resolver.type, resolverTarget(resolver)]),
    ]),
  );
}

/** Creates the resolver when the Space has none by that id, and replaces it otherwise. */
export async function set(command: Command, spaceId: string, text: string): Promise<void> {
  const { client, output, flags } = command;
  const request = resolverRequest(text);
  const resolverId = request.resolver.id;
  const existing = (await client.space(spaceId)).space.policy.resolvers;
  const replaced = existing.some((resolver) => resolver.id === resolverId);
  const result = replaced
    ? await client.replaceResolver(spaceId, resolverId, request)
    : await client.createResolver(spaceId, request);
  if (flags.json) return output.out(JSON.stringify(result, null, 2));
  output.out(`${replaced ? "Replaced" : "Created"} resolver ${resolverId} on ${spaceId}.`);
}

export async function remove(command: Command, spaceId: string, resolverId: string): Promise<void> {
  const { client, output, flags } = command;
  if (!flags.yes) {
    throw new CliError(
      `removing ${resolverId} breaks every Delivery URL that names it; pass --yes to confirm`,
    );
  }
  const result = await client.removeResolver(spaceId, resolverId);
  output.out(flags.json ? JSON.stringify(result, null, 2) : `Removed resolver ${resolverId}.`);
}

/** Answers whether the sample reference resolved and its first byte could be fetched. */
export async function test(
  command: Command,
  spaceId: string,
  resolverId: string,
  reference: readonly string[],
): Promise<boolean> {
  const { client, output, flags } = command;
  const result = await client.testResolver(spaceId, resolverId, { reference });
  if (flags.json) output.out(JSON.stringify(result, null, 2));
  else {
    const facts = [result.host, result.status, result.contentType].filter(
      (fact) => fact !== undefined,
    );
    output.out(
      `${result.outcome}: ${result.message}${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`,
    );
  }
  return result.outcome === "ok";
}
