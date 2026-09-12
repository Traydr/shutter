import { type ErrorComponentProps, Link } from "@tanstack/react-router";
import { ControlReadError } from "../features/spaces/spaces-queries";
import { AppHeader } from "./header";
import { Button, Panel } from "./ui";

/** What a page shows when its read of Control failed. */
export function ControlErrorView({ error, reset }: ErrorComponentProps) {
  const failure = error instanceof ControlReadError ? error.failure : undefined;
  const title = failure?.status === 404 ? "Not found" : "Control did not answer";
  return (
    <>
      <AppHeader />
      <main className="mx-auto grid max-w-lg gap-3.5 px-4 py-10">
        <Panel className="grid gap-2 p-4">
          <h1 className="m-0 text-[17px] font-semibold">{title}</h1>
          <p className="m-0 text-ink-2 [overflow-wrap:anywhere]">{error.message}</p>
          {failure?.requestId === undefined ? null : (
            <p className="m-0 text-[11.5px] text-ink-3">Request {failure.requestId}</p>
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={reset}>
              Try again
            </Button>
            <Link to="/" className="self-center text-brand-ink hover:underline">
              Back to Spaces
            </Link>
          </div>
        </Panel>
      </main>
    </>
  );
}
