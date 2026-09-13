import { getRouteApi, Link, type LinkProps, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { buttonClass, cx } from "./ui";

const root = getRouteApi("__root__");

export interface Crumb {
  label: ReactNode;
  link?: LinkProps;
}

function Logo({ size = 22 }: { size?: number }) {
  return <img src="/favicon.svg" alt="" width={size} height={size} className="block" />;
}

function ThemeToggle() {
  const { theme } = root.useLoaderData();
  const { pathname } = useLocation();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <form method="post" action="/api/theme" className="inline">
      <input type="hidden" name="theme" value={next} />
      <input type="hidden" name="back" value={pathname} />
      <button
        type="submit"
        title={`Switch to ${next} mode`}
        aria-label={`Switch to ${next} mode`}
        className={cx(buttonClass("ghost", "sm"), "w-[30px] px-0")}
      >
        {theme === "dark" ? (
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
          </svg>
        ) : (
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z" />
          </svg>
        )}
      </button>
    </form>
  );
}

/** The top strip: brand, breadcrumb, theme, sign out. */
export function AppHeader({ crumbs = [] }: { crumbs?: readonly Crumb[] }) {
  return (
    <header className="flex h-14 items-center gap-3 border-b border-line px-6">
      <Link to="/" className="flex items-center gap-2.5 font-semibold">
        <Logo />
        Shutter
      </Link>
      {crumbs.map((crumb, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: crumbs are positional
        <span key={index} className="flex items-center gap-3">
          <span className="text-xl font-extralight text-line-3">/</span>
          {crumb.link === undefined ? (
            <span className="font-mono text-[13.5px] font-medium">{crumb.label}</span>
          ) : (
            <Link {...crumb.link} className="font-mono text-[13.5px] font-medium hover:underline">
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
      <span className="flex-1" />
      <ThemeToggle />
      <form method="post" action="/api/auth/logout" className="inline">
        <button type="submit" className={buttonClass("ghost", "sm")}>
          Sign out
        </button>
      </form>
    </header>
  );
}

export type SpaceTab = "overview" | "sources" | "access" | "settings";

const TABS = [
  ["overview", "Overview"],
  ["sources", "Sources"],
  ["access", "Access"],
  ["settings", "Settings"],
] as const;

/** The tab strip under the header on every Space page. */
export function SpaceTabs({ spaceId, active }: { spaceId: string; active: SpaceTab }) {
  const to = {
    overview: "/spaces/$spaceId",
    sources: "/spaces/$spaceId/sources",
    access: "/spaces/$spaceId/access",
    settings: "/spaces/$spaceId/settings",
  } as const;
  return (
    <nav aria-label="Space sections" className="flex gap-1 border-b border-line px-6">
      {TABS.map(([key, label]) => (
        <Link
          key={key}
          to={to[key]}
          params={{ spaceId }}
          className={cx(
            "relative px-2 pb-3.5 pt-3 text-sm",
            key === active
              ? "text-fg after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:bg-fg"
              : "text-fg-2 hover:text-fg",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
