import type { ErrorComponentProps } from "@tanstack/react-router";
import { ControlReadError } from "../features/spaces/spaces-queries";
import { AppHeader } from "./header";
import { Button, Card, TextLink } from "./ui";

/** What a page shows when its read of Control failed. */
export function ControlErrorView({ error, reset }: ErrorComponentProps) {
  const failure = error instanceof ControlReadError ? error.failure : undefined;
  const title = failure?.status === 404 ? "Not found" : "Control did not answer";
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-lg px-6 py-16">
        <Card className="grid gap-3 p-6">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">{title}</h1>
          <p className="text-fg-2 [overflow-wrap:anywhere]">{error.message}</p>
          {failure?.requestId === undefined ? null : (
            <p className="text-[13px] text-fg-3">Request {failure.requestId}</p>
          )}
          <div className="flex items-center gap-4 pt-1">
            <Button type="button" onClick={reset}>
              Try again
            </Button>
            <TextLink to="/">Back to Spaces</TextLink>
          </div>
        </Card>
      </main>
    </>
  );
}
