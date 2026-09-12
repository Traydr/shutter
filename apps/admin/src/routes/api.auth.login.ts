import { createHash, timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env/server";
import { clientAddress } from "../server/client-ip";
import { createLoginThrottle } from "../server/login-throttle";
import { serializeCookie, sessions } from "../server/session-guard";

const throttle = createLoginThrottle();

function digest(value: string): Uint8Array {
  return createHash("sha256").update(value, "utf8").digest();
}

function back(error: "invalid" | "locked" | "unconfigured"): Response {
  return new Response(null, { status: 303, headers: { location: `/login?error=${error}` } });
}

export const Route = createFileRoute("/api/auth/login")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!sessions.isConfigured()) return back("unconfigured");
        const address = clientAddress(request, env.ADMIN_TRUST_PROXY_HEADERS);
        if (throttle.isThrottled(address)) return back("locked");
        let token = "";
        try {
          const form = await request.formData();
          const value = form.get("token");
          token = value === null ? "" : String(value);
        } catch {
          return back("invalid");
        }
        if (!timingSafeEqual(digest(token), digest(env.ADMIN_BOOTSTRAP_TOKEN))) {
          throttle.recordFailure(address);
          return back("invalid");
        }
        throttle.clear(address);
        const { cookie } = sessions.create();
        return new Response(null, {
          status: 303,
          headers: { location: "/", "set-cookie": serializeCookie(cookie) },
        });
      },
    },
  },
});
