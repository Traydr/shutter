import { defineConfig } from "drizzle-kit";
import { env } from "./src/env/server.js";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: env.DATABASE_URL ?? "postgresql://localhost/shutter" },
});
