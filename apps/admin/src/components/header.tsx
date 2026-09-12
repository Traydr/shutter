import { Link } from "@tanstack/react-router";

/** The top strip: brand, breadcrumb, sign out. */
export function AppHeader({ crumb }: { crumb?: string }) {
  return (
    <header className="flex h-[38px] items-center gap-3.5 border-b border-rule bg-panel px-4">
      <Link to="/" className="text-[11.5px] font-extrabold tracking-[.12em] text-ink">
        SHUTTER
      </Link>
      <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink-2">
        {crumb === undefined ? (
          <b className="font-semibold text-ink">Spaces</b>
        ) : (
          <>
            <Link to="/" className="text-brand-ink hover:underline">
              Spaces
            </Link>
            <span className="text-ink-3">/</span>
            <b className="truncate font-mono font-semibold text-ink">{crumb}</b>
          </>
        )}
      </span>
      <span className="flex-1" />
      <form method="post" action="/api/auth/logout" className="inline">
        <button
          type="submit"
          className="cursor-pointer rounded-md border border-transparent px-[7px] py-[3px] text-[11px] font-semibold text-ink-2 hover:text-ink"
        >
          Sign out
        </button>
      </form>
    </header>
  );
}
