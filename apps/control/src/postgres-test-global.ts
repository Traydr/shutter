import { PostgreSqlContainer } from "@testcontainers/postgresql";

export default async function setupPostgres(): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  process.env.TEST_POSTGRES_URL = container.getConnectionUri();
  return () => container.stop().then(() => undefined);
}
