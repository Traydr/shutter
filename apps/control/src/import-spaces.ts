import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { CapabilityKeyEncryption } from "./spaces/encryption.js";
import { PostgresSpaceRegistry } from "./spaces/postgres-registry.js";
import { importRegistry, parseRegistryImport } from "./spaces/registry-import.js";

const inputPath = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.SHUTTER_ENCRYPTION_KEY;
if (inputPath === undefined || databaseUrl === undefined || encryptionKey === undefined) {
  console.error(
    "Usage: DATABASE_URL=... SHUTTER_ENCRYPTION_KEY=... pnpm --filter @shutter/control db:import-spaces <input.json>",
  );
  process.exitCode = 1;
} else {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const input = parseRegistryImport(JSON.parse(await readFile(inputPath, "utf8")));
    const registry = new PostgresSpaceRegistry(pool, {
      encryption: new CapabilityKeyEncryption(encryptionKey),
    });
    const result = await importRegistry(registry, input);
    console.log(`Imported ${result.spaceCount} Spaces at generation ${result.generation}.`);
  } catch (error) {
    // The import runs inside a timed maintenance window; the operator needs
    // the precise diagnostic. Parse and verification messages name fields,
    // never token or key material.
    console.error("Space Registry import failed.");
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
