import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { ReactNode } from "react";
import { TextLink } from "../components/ui";
import { readTheme } from "../server/theme";
import appCss from "../styles.css?url";

const getTheme = createServerFn({ method: "GET" }).handler(() => ({
  theme: readTheme(getRequest().headers.get("cookie")),
}));

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  loader: () => getTheme(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "robots", content: "noindex,nofollow" },
      { title: "Shutter admin" },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  notFoundComponent: () => (
    <main className="mx-auto max-w-lg px-6 py-16">
      <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Not found</h1>
      <p className="mt-2 text-fg-2">
        The page does not exist. <TextLink to="/">Back to Spaces</TextLink>
      </p>
    </main>
  ),
  component: RootComponent,
});

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  const { theme } = Route.useLoaderData();
  return (
    <html lang="en" data-theme={theme}>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}
