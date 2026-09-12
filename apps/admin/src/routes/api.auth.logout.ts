import { createFileRoute } from "@tanstack/react-router";
import { isSameOriginRequest } from "../server/same-origin";
import { serializeCookie, sessions } from "../server/session-guard";

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!isSameOriginRequest(request)) return new Response(null, { status: 403 });
        return new Response(null, {
          status: 303,
          headers: { location: "/login", "set-cookie": serializeCookie(sessions.clearCookie()) },
        });
      },
    },
  },
});
