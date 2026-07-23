import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { setTestPostgresUrl } from "./env/server.js";

export default async function setupPostgres(): Promise<() => Promise<void>> {
  try {
    const container = await new PostgreSqlContainer("postgres:17-alpine").start();
    setTestPostgresUrl(container.getConnectionUri());
    return () => container.stop().then(() => undefined);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `pnpm test:node requires a working Docker daemon for Postgres testcontainers. ${detail}`,
      { cause: error },
    );
  }
}
