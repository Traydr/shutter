import { createFileRoute } from "@tanstack/react-router";
import { isSameOriginRequest } from "../server/same-origin";
import { safeReturnPath, serializeThemeCookie, THEME_SCHEMA } from "../server/theme";

export const Route = createFileRoute("/api/theme")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        if (!isSameOriginRequest(request)) return new Response(null, { status: 403 });
        const form = await request.formData();
        const theme = THEME_SCHEMA.safeParse(form.get("theme"));
        if (!theme.success) return new Response(null, { status: 400 });
        const back = form.get("back");
        return new Response(null, {
          status: 303,
          headers: {
            location: safeReturnPath(back === null || back instanceof File ? "/" : back),
            "set-cookie": serializeThemeCookie(theme.data),
          },
        });
      },
    },
  },
});
