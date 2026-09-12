import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { getSessionStatus } from "../features/auth/auth-service";

const MESSAGES = {
  invalid: "The token was not accepted.",
  locked: "Too many failed attempts. Try again in a few minutes.",
  unconfigured: "This admin has no bootstrap token configured.",
} as const;

export const Route = createFileRoute("/login")({
  validateSearch: z.object({ error: z.enum(["invalid", "locked", "unconfigured"]).optional() }),
  beforeLoad: async () => {
    const { authenticated } = await getSessionStatus();
    if (authenticated) throw redirect({ to: "/" });
  },
  head: () => ({ meta: [{ title: "Sign in · Shutter admin" }] }),
  component: LoginPage,
});

function LoginPage() {
  const { error } = Route.useSearch();
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <form
        method="post"
        action="/api/auth/login"
        className="grid w-full max-w-sm gap-4 rounded-lg border border-rule bg-panel p-5"
      >
        <div className="flex items-center gap-3 border-b border-rule-2 pb-4">
          <img src="/favicon.svg" alt="" width={32} height={32} className="size-8" />
          <div>
            <strong className="block text-sm font-semibold tracking-[.12em]">SHUTTER</strong>
            <span className="block text-xs text-ink-3">Space administration</span>
          </div>
        </div>
        <label className="grid gap-1.5">
          <span className="text-xs font-semibold">Bootstrap token</span>
          <input
            type="password"
            name="token"
            required
            autoComplete="current-password"
            className="w-full rounded-md border border-rule bg-panel px-2.5 py-1.5 text-[13px]"
          />
        </label>
        {error === undefined ? null : (
          <p className="m-0 rounded-md border-l-[3px] border-red bg-red-bg px-3 py-2 text-[12.5px] text-red">
            {MESSAGES[error]}
          </p>
        )}
        <button
          type="submit"
          className="rounded-md bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand-ink"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
