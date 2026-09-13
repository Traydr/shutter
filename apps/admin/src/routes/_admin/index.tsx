import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { CopyButton } from "../../components/copy-button";
import { ControlErrorView } from "../../components/error-view";
import { AppHeader } from "../../components/header";
import {
  Ago,
  CodeBlock,
  cx,
  Input,
  LinkButton,
  Notice,
  PageTitle,
  plural,
  StateLine,
} from "../../components/ui";
import { overviewQuery } from "../../features/spaces/spaces-queries";
import { edgeSentence, overviewSpaceState } from "../../features/spaces/summaries";

export const Route = createFileRoute("/_admin/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(overviewQuery()),
  errorComponent: ControlErrorView,
  head: () => ({ meta: [{ title: "Spaces · Shutter admin" }] }),
  component: OverviewPage,
});

function OverviewPage() {
  const overview = useSuspenseQuery(overviewQuery()).data;
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const spaces = overview.spaces.filter(
    (space) =>
      needle.length === 0 ||
      space.policy.id.includes(needle) ||
      space.policy.allowedSourceOrigins.some((rule) => rule.origin.includes(needle)),
  );
  const edge = edgeSentence(overview);
  const { uncovered, derivedValue } = overview.coverage;

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-[1080px] px-6 pb-20 pt-10">
        <div className="mb-8 flex items-center gap-4">
          <PageTitle>Spaces</PageTitle>
          <span className="flex-1" />
          <Input
            type="search"
            placeholder="Search…"
            aria-label="Search Spaces"
            className="max-w-[360px]"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <LinkButton to="/spaces/new" tone="primary">
            Add Space
          </LinkButton>
        </div>

        {spaces.length === 0 ? (
          <p className="text-fg-2">
            {overview.spaces.length === 0
              ? "No Spaces yet. Add one for the first application."
              : "No Space matches."}
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
            {spaces.map((space) => {
              const state = overviewSpaceState(space, uncovered);
              const off = space.status !== "active";
              return (
                <Link
                  key={space.policy.id}
                  to="/spaces/$spaceId"
                  params={{ spaceId: space.policy.id }}
                  className={cx(
                    "grid min-w-0 gap-4 rounded-[10px] border border-line bg-s1 px-6 py-[22px] transition-colors hover:border-line-3",
                    off && "opacity-50",
                  )}
                >
                  <div>
                    <div className="text-[17px] font-semibold tracking-[-0.01em]">
                      {space.policy.id}
                    </div>
                    <div className="mt-0.5 text-[13.5px] text-fg-2">
                      {space.policy.routeClass === "public" ? "Public" : "Private"} ·{" "}
                      {plural(space.policy.resolvers.length, "source")}
                    </div>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 text-[13px] text-fg-2">
                    <StateLine tone={state.tone} className="min-w-0 flex-1">
                      <span className="block truncate" title={state.text}>
                        {state.text}
                      </span>
                    </StateLine>
                    <Ago value={space.updatedAt} />
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        <div className="mt-9 grid gap-5 text-[13.5px] text-fg-2">
          <StateLine tone={edge.tone}>{edge.text}</StateLine>
          {uncovered.length === 0 ? (
            <details className="grid gap-3">
              <summary className="cursor-pointer select-none">
                Every active origin is in the deployed image-proxy allowlist. Show the value.
              </summary>
              <CodeBlock>
                {derivedValue === "" ? "No active Space origins" : derivedValue}
              </CodeBlock>
              <div>
                <CopyButton value={derivedValue} label="Copy allowlist" />
              </div>
            </details>
          ) : (
            <div className="grid gap-3">
              <Notice tone="warn">
                {plural(uncovered.length, "origin")} {uncovered.length === 1 ? "isn't" : "aren't"}{" "}
                in the deployed image-proxy allowlist yet: {uncovered.join(", ")}. Paste this value
                into IMGPROXY_ALLOWED_SOURCES and redeploy.
              </Notice>
              <CodeBlock>{derivedValue}</CodeBlock>
              <div>
                <CopyButton value={derivedValue} label="Copy allowlist" />
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
