import { createFileRoute, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { Button, Field, Input, Notice } from "../components/ui";
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
        className="grid w-full max-w-sm gap-6 rounded-[10px] border border-line bg-s1 p-7"
      >
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" width={32} height={32} className="size-8" />
          <div>
            <strong className="block text-[15px] font-semibold">Shutter</strong>
            <span className="block text-[13px] text-fg-2">Sign in to manage Spaces</span>
          </div>
        </div>
        <Field label="Bootstrap token">
          <Input type="password" name="token" required autoComplete="current-password" />
        </Field>
        {error === undefined ? null : <Notice tone="error">{MESSAGES[error]}</Notice>}
        <Button tone="primary" type="submit">
          Sign in
        </Button>
      </form>
    </main>
  );
}
