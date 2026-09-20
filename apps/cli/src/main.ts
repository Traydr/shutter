import { parseArgs } from "node:util";
import { AdminApiError } from "@shutter/admin-api";
import { login, logout, status } from "./commands/auth.js";
import { addKey, disableKey, issueToken, revokeToken } from "./commands/credentials.js";
import * as resolvers from "./commands/resolvers.js";
import * as spaces from "./commands/spaces.js";
import { resolveCredentials } from "./config.js";
import type { CliContext, Command, Flags } from "./context.js";
import { CliError } from "./io.js";

export const USAGE = `shutter — administer a Shutter deployment through Control's admin API

Usage:
  shutter overview
  shutter allowlist [--check]
  shutter space ls
  shutter space get <space>
  shutter space create <space> --route-class public|private --origin URL... [--qualities 60,80] [--default-quality 80]
  shutter space update <space> [--origin URL...] [--qualities 60,80] [--default-quality 80]
  shutter space decommission <space> --yes
  shutter resolver ls <space>
  shutter resolver set <space> --file resolver.json      (- reads stdin; creates or replaces by id)
  shutter resolver rm <space> <resolver> --yes
  shutter resolver test <space> <resolver> <segment>...
  shutter token issue <space> --label LABEL
  shutter token revoke <space> <token-id>
  shutter key add <space> <key-id>
  shutter key disable <space> <key-id> --yes
  shutter auth login [--url URL] [--token TOKEN]
  shutter auth logout
  shutter auth status

Global flags:
  --json          print the admin API document instead of a summary
  --url URL       override Control's URL (or SHUTTER_URL)
  --token TOKEN   override the admin API token (or SHUTTER_TOKEN)
  -h, --help

Credentials resolve flags → env → ~/.config/shutter/credentials.
--origin is https://host[/path-prefix] and repeats; on update it replaces the whole list.
allowlist prints the IMGPROXY_ALLOWED_SOURCES value to deploy; --check exits 1 while
the deployed value misses an entry. An issued secret is the only thing on stdout.`;

function usage(text: string): CliError {
  return new CliError(`usage: shutter ${text}`);
}

function required(value: string | undefined, text: string): string {
  if (value === undefined) throw usage(text);
  return value;
}

/** Runs one invocation and answers its exit code. */
async function dispatch(argv: readonly string[], context: CliContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      json: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      label: { type: "string" },
      file: { type: "string" },
      "route-class": { type: "string" },
      origin: { type: "string", multiple: true, default: [] },
      qualities: { type: "string" },
      "default-quality": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const flags: Flags = {
    url: values.url,
    token: values.token,
    json: values.json,
    yes: values.yes,
    check: values.check,
    label: values.label,
    file: values.file,
    routeClass: values["route-class"],
    origins: values.origin,
    qualities: values.qualities,
    defaultQuality: values["default-quality"],
  };
  const [noun, verb, ...rest] = positionals;
  if (values.help || noun === undefined) {
    context.output.out(USAGE);
    return noun === undefined && !values.help ? 1 : 0;
  }

  if (noun === "auth") {
    if (verb === "login") await login(context, flags);
    else if (verb === "logout") await logout(context);
    else if (verb === "status") return (await status(context, flags)) ? 0 : 1;
    else throw usage("auth <login|logout|status>");
    return 0;
  }

  const credentials = await resolveCredentials(flags, context.env, context.credentials);
  if (credentials === null) {
    throw new CliError(
      "not logged in — run `shutter auth login` or set SHUTTER_URL and SHUTTER_TOKEN",
    );
  }
  const command: Command = { client: context.connect(credentials), output: context.output, flags };

  switch (`${noun} ${verb ?? ""}`.trim()) {
    case "overview":
      await spaces.overview(command);
      return 0;
    case "allowlist":
      return (await spaces.allowlist(command)) ? 0 : 1;
    case "space ls":
      await spaces.list(command);
      return 0;
    case "space get":
      await spaces.get(command, required(rest[0], "space get <space>"));
      return 0;
    case "space create":
      await spaces.create(command, required(rest[0], "space create <space> …"));
      return 0;
    case "space update":
      await spaces.update(command, required(rest[0], "space update <space> …"));
      return 0;
    case "space decommission":
      await spaces.decommission(command, required(rest[0], "space decommission <space> --yes"));
      return 0;
    case "resolver ls":
      await resolvers.list(command, required(rest[0], "resolver ls <space>"));
      return 0;
    case "resolver set": {
      const text = "resolver set <space> --file resolver.json";
      const spaceId = required(rest[0], text);
      await resolvers.set(command, spaceId, await context.readInput(required(flags.file, text)));
      return 0;
    }
    case "resolver rm": {
      const text = "resolver rm <space> <resolver> --yes";
      await resolvers.remove(command, required(rest[0], text), required(rest[1], text));
      return 0;
    }
    case "resolver test": {
      const text = "resolver test <space> <resolver> <segment>...";
      const [spaceId, resolverId, ...reference] = rest;
      if (reference.length === 0) throw usage(text);
      const ok = await resolvers.test(
        command,
        required(spaceId, text),
        required(resolverId, text),
        reference,
      );
      return ok ? 0 : 1;
    }
    case "token issue":
      await issueToken(command, required(rest[0], "token issue <space> --label LABEL"));
      return 0;
    case "token revoke": {
      const text = "token revoke <space> <token-id>";
      await revokeToken(command, required(rest[0], text), required(rest[1], text));
      return 0;
    }
    case "key add": {
      const text = "key add <space> <key-id>";
      await addKey(command, required(rest[0], text), required(rest[1], text));
      return 0;
    }
    case "key disable": {
      const text = "key disable <space> <key-id> --yes";
      await disableKey(command, required(rest[0], text), required(rest[1], text));
      return 0;
    }
    default:
      throw new CliError(`unknown command: ${[noun, verb].filter(Boolean).join(" ")}\n\n${USAGE}`);
  }
}

function failureLine(cause: unknown): string {
  if (cause instanceof AdminApiError) {
    const request = cause.requestId === undefined ? "" : ` (request ${cause.requestId})`;
    return `error: ${cause.code}: ${cause.message}${request}`;
  }
  return `error: ${cause instanceof Error ? cause.message : "unknown failure"}`;
}

export async function run(argv: readonly string[], context: CliContext): Promise<number> {
  try {
    return await dispatch(argv, context);
  } catch (error) {
    context.output.err(failureLine(error));
    return 1;
  }
}
