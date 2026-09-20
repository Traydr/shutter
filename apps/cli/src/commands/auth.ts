import { AdminApiError } from "@shutter/admin-api";
import { resolveCredentials } from "../config.js";
import type { CliContext, Flags } from "../context.js";
import { CliError } from "../io.js";

export async function login(context: CliContext, flags: Flags): Promise<void> {
  const url = (flags.url ?? (await context.prompt("Control URL: "))).trim().replace(/\/+$/u, "");
  if (!/^https?:\/\//u.test(url)) throw new CliError("URL must start with http:// or https://");
  const token = (flags.token ?? (await context.prompt("Admin API token (hidden): ", true))).trim();
  if (token === "") throw new CliError("token is required");

  await context.connect({ url, token }).overview(); // proves both; throws AdminApiError otherwise
  await context.credentials.write({ url, token });
  context.output.out(
    `Logged in to ${url}. Credentials saved to ${context.credentials.path()} (mode 0600).`,
  );
}

export async function logout(context: CliContext): Promise<void> {
  const removed = await context.credentials.remove();
  context.output.out(removed ? `Removed ${context.credentials.path()}` : "Not logged in.");
}

/** Answers whether the stored credentials work; the exit code says so too. */
export async function status(context: CliContext, flags: Flags): Promise<boolean> {
  const credentials = await resolveCredentials(flags, context.env, context.credentials);
  if (credentials === null) {
    context.output.err("Not logged in. Run `shutter auth login`.");
    return false;
  }
  let verdict = "valid";
  try {
    await context.connect(credentials).overview();
  } catch (error) {
    if (!(error instanceof AdminApiError)) throw error;
    verdict = error.code === "unauthorized" ? "rejected" : `unverified (${error.message})`;
  }
  const file = credentials.source === "file" ? ` (${context.credentials.path()})` : "";
  context.output.out(`URL:     ${credentials.url}`);
  context.output.out(`Source:  ${credentials.source}${file}`);
  context.output.out(`Token:   ${verdict}`);
  return verdict === "valid";
}
