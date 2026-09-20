import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Control's origin and the `ADMIN_API_TOKEN` it was deployed with. */
export interface Credentials {
  url: string;
  token: string;
}

export type CredentialSource = "flags" | "env" | "file";

export interface ResolvedCredentials extends Credentials {
  source: CredentialSource;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export interface CredentialFlags {
  url?: string | undefined;
  token?: string | undefined;
}

/** The credentials file, behind a seam so tests never touch the home directory. */
export interface CredentialStore {
  path(): string;
  read(): Promise<Credentials | null>;
  write(credentials: Credentials): Promise<void>;
  remove(): Promise<boolean>;
}

export function configDir(env: Environment): string {
  if (process.platform === "win32" && env.APPDATA) return join(env.APPDATA, "shutter");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "shutter");
}

/** Parse the `key=value` credentials file. Unknown keys are ignored. */
export function parseCredentialsFile(text: string): Credentials | null {
  let url: string | undefined;
  let token: string | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key === "url") url = value;
    if (key === "token") token = value;
  }
  if (url === undefined || token === undefined) return null;
  return { url, token };
}

function missing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

export function fileCredentialStore(env: Environment): CredentialStore {
  const directory = configDir(env);
  const path = join(directory, "credentials");
  return {
    path: () => path,
    async read() {
      try {
        return parseCredentialsFile(await readFile(path, "utf8"));
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    },
    async write(credentials) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const content = `# shutter credentials — keep private\nurl=${credentials.url}\ntoken=${credentials.token}\n`;
      await writeFile(path, content, { mode: 0o600 });
      await chmod(path, 0o600);
    },
    async remove() {
      try {
        await rm(path);
        return true;
      } catch (error) {
        if (missing(error)) return false;
        throw error;
      }
    },
  };
}

/** flags → env → credentials file. */
export async function resolveCredentials(
  flags: CredentialFlags,
  env: Environment,
  store: CredentialStore,
): Promise<ResolvedCredentials | null> {
  const file = await store.read();
  const url = flags.url ?? env.SHUTTER_URL ?? file?.url;
  const token = flags.token ?? env.SHUTTER_TOKEN ?? file?.token;
  if (url === undefined || token === undefined) return null;
  const source: CredentialSource =
    flags.url !== undefined || flags.token !== undefined
      ? "flags"
      : env.SHUTTER_URL || env.SHUTTER_TOKEN
        ? "env"
        : "file";
  return { url: url.replace(/\/+$/u, ""), token, source };
}
