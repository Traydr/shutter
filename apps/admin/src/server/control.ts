import { type AdminApiClient, createAdminApiClient } from "@shutter/admin-api";
import { env } from "../env/server";

let client: AdminApiClient | undefined;

/** The one client this server talks to Control with; built on first use so a build never dials. */
export function control(): AdminApiClient {
  client ??= createAdminApiClient({
    baseUrl: env.CONTROL_BASE_URL,
    token: env.CONTROL_ADMIN_TOKEN,
  });
  return client;
}
