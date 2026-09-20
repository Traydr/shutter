import type { AdminApiClient } from "@shutter/admin-api";
import type { CredentialStore, Credentials, Environment } from "./config.js";
import type { Output } from "./io.js";

/** Everything a command touches outside its arguments; tests pass fakes through it. */
export interface CliContext {
  env: Environment;
  output: Output;
  credentials: CredentialStore;
  connect(credentials: Credentials): AdminApiClient;
  /** Reads a whole file, or stdin for `-`. */
  readInput(path: string): Promise<string>;
  prompt(question: string, hidden?: boolean): Promise<string>;
}

/** The flags every command may read; `parseArgs` in `main.ts` produces them. */
export interface Flags {
  url?: string | undefined;
  token?: string | undefined;
  json: boolean;
  yes: boolean;
  check: boolean;
  label?: string | undefined;
  file?: string | undefined;
  routeClass?: string | undefined;
  origins: readonly string[];
  qualities?: string | undefined;
  defaultQuality?: string | undefined;
}

export interface Command {
  client: AdminApiClient;
  output: Output;
  flags: Flags;
}
