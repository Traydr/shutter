import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * The admin application's configuration. It holds exactly two secrets: the
 * operator's bootstrap token (its own login and the session signing key) and
 * Control's admin credential, which never leaves this server.
 */
export const env = createEnv({
  server: {
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Control's origin. On Railway the private domain; locally the public one or a dev Control. */
    CONTROL_BASE_URL: z.url(),
    /** Control's `ADMIN_API_TOKEN`. */
    CONTROL_ADMIN_TOKEN: z.string().min(32),
    /** The operator's login credential; also signs the session cookie. */
    ADMIN_BOOTSTRAP_TOKEN: z.string().min(32),
    /** Trust X-Forwarded-For for the login lockout key. True behind Railway's proxy. */
    ADMIN_TRUST_PROXY_HEADERS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  },
  clientPrefix: "VITE_",
  client: {},
  runtimeEnv: process.env,
  skipValidation: Boolean(process.env.SKIP_ENV_VALIDATION),
  emptyStringAsUndefined: true,
});
