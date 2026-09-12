import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { z } from "zod";
import { ControlErrorView } from "../../components/error-view";
import { AppHeader } from "../../components/header";
import { HINTS } from "../../components/hints";
import {
  Button,
  Code,
  ErrorNotice,
  Field,
  Hint,
  INPUT_CLASS,
  Input,
  Notice,
  Panel,
  PanelHead,
  Pill,
  plural,
  RouteClassChip,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
  Time,
  WarnBox,
} from "../../components/ui";
import { createSpaceBody, FormInputError } from "../../features/spaces/forms";
import { overviewQuery, spaceKeys } from "../../features/spaces/spaces-queries";
import { createSpace } from "../../features/spaces/spaces-service";
import { edgeState, originPrefix, withoutScheme } from "../../features/spaces/summaries";
import { describeFailure, describeThrown } from "../../server/failure";

export const Route = createFileRoute("/_admin/")({
  validateSearch: z.object({ generation: z.coerce.number().int().nonnegative().optional() }),
  loader: ({ context }) => context.queryClient.ensureQueryData(overviewQuery()),
  errorComponent: ControlErrorView,
  head: () => ({ meta: [{ title: "Spaces · Shutter admin" }] }),
  component: OverviewPage,
});

function EdgeSentence({ overview }: { overview: ReturnType<typeof useOverview> }) {
  const state = edgeState(overview);
  switch (state.kind) {
    case "unreported":
      return (
        <>
          <span className="font-semibold text-amber">Latest Edge refresh: not reported yet</span>.
          The Edge reports after its first successful snapshot refresh.
        </>
      );
    case "in-sync":
      return (
        <>
          Latest Edge refresh: generation <span className="num">{state.generation}</span>,{" "}
          <span className="font-semibold text-brand-ink">in sync</span>, at{" "}
          <Time value={state.refreshedAt} />.
        </>
      );
    case "behind":
      return (
        <>
          Latest Edge refresh: generation <span className="num">{state.generation}</span>,{" "}
          <span className="font-semibold text-amber">
            behind by {plural(state.lag, "generation")}
          </span>
          , at <Time value={state.refreshedAt} />.
        </>
      );
  }
}

function useOverview() {
  return useSuspenseQuery(overviewQuery()).data;
}

function OverviewPage() {
  const overview = useOverview();
  const { generation } = Route.useSearch();
  const active = overview.spaces.filter((space) => space.status === "active").length;
  const uncovered = overview.coverage.uncovered;

  return (
    <>
      <AppHeader />
      <main className="mx-auto grid max-w-[1240px] gap-3.5 px-4 pb-10 pt-3.5">
        {generation !== undefined && generation === overview.generation ? (
          <Notice>The registry is now at generation {generation}.</Notice>
        ) : null}

        <Panel className="flex items-center gap-2.5 px-3 py-2.5">
          <p className="m-0">
            Registry generation <span className="num">{overview.generation}</span>
            <Hint text={HINTS.generation} />. <EdgeSentence overview={overview} />{" "}
            {uncovered.length === 0 ? (
              <>
                <span className="font-semibold text-brand-ink">Every active source origin</span> is
                in the imgproxy allowlist.
              </>
            ) : (
              <>
                <span className="font-semibold text-amber">
                  {plural(uncovered.length, "active source origin")}
                </span>{" "}
                {uncovered.length === 1 ? "is" : "are"} missing from the imgproxy allowlist.
              </>
            )}
          </p>
          <span className="flex-1" />
          {uncovered.length === 0 ? null : (
            <a href="#allowlist" className="text-[11.5px] font-semibold text-ink-2">
              Fix allowlist ↓
            </a>
          )}
        </Panel>

        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="m-0 text-[17px] font-semibold tracking-[-.01em]">Spaces</h1>
          <span className="text-ink-3">
            {overview.spaces.length} · {active} active
          </span>
          <span className="flex-1" />
          <a
            href="#create"
            className="rounded-md border border-brand bg-brand px-[7px] py-[3px] text-[11px] font-semibold text-white"
          >
            + New Space
          </a>
        </div>

        <Panel>
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th className={TH_CLASS}>Space</th>
                  <th className={TH_CLASS}>
                    Class
                    <Hint text={HINTS.routeClass} />
                  </th>
                  <th className={TH_CLASS}>Status</th>
                  <th className={TH_CLASS}>Origins</th>
                  <th className={TH_CLASS}>Resolvers</th>
                  <th className={TH_CLASS}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {overview.spaces.length === 0 ? (
                  <tr>
                    <td colSpan={6} className={`${TD_CLASS} text-ink-3`}>
                      No Spaces yet. Create one below.
                    </td>
                  </tr>
                ) : (
                  overview.spaces.map((space) => {
                    const off = space.status !== "active";
                    return (
                      <tr key={space.policy.id} className={off ? "text-ink-3" : ""}>
                        <td className={`${TD_CLASS} font-mono text-[12.5px] font-medium`}>
                          <Link
                            to="/spaces/$spaceId"
                            params={{ spaceId: space.policy.id }}
                            className={off ? "text-ink-3" : "text-brand-ink hover:underline"}
                          >
                            {space.policy.id}
                          </Link>
                        </td>
                        <td className={TD_CLASS}>
                          <RouteClassChip routeClass={space.policy.routeClass} />
                        </td>
                        <td className={TD_CLASS}>
                          {off ? <Pill>decommissioned</Pill> : <Pill tone="ok">active</Pill>}
                        </td>
                        <td className={TD_CLASS}>
                          <div className="grid gap-0.5 font-mono text-[12px] text-ink-2">
                            {space.policy.allowedSourceOrigins.map((rule) => {
                              const prefix = originPrefix(rule);
                              return (
                                <span key={prefix} className="flex items-center gap-1.5">
                                  {withoutScheme(prefix)}
                                  {!off && uncovered.includes(prefix) ? (
                                    <Pill tone="warn" small>
                                      not deployed
                                    </Pill>
                                  ) : null}
                                </span>
                              );
                            })}
                          </div>
                        </td>
                        <td className={`${TD_CLASS} num`}>{space.policy.resolvers.length}</td>
                        <td className={`${TD_CLASS} text-ink-2`}>
                          <Time value={space.updatedAt} />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="grid items-start gap-3.5 md:grid-cols-2">
          <Panel id="allowlist">
            <PanelHead
              title={
                <>
                  imgproxy allowlist
                  <Hint text={HINTS.allowlist} />
                </>
              }
            >
              <span className="text-ink-3">
                paste into <Code>IMGPROXY_ALLOWED_SOURCES</Code>
              </span>
            </PanelHead>
            <div className="grid gap-2 p-2.5">
              <div className="rounded-md bg-[#13231e] px-2.5 py-2 font-mono text-[12px] text-[#e5fff7] [overflow-wrap:anywhere]">
                {overview.coverage.derivedValue === ""
                  ? "No active Space origins"
                  : overview.coverage.derivedValue}
              </div>
              {uncovered.length === 0 ? (
                <Notice>The deployed allowlist covers every active Space origin.</Notice>
              ) : (
                <WarnBox>
                  <strong>Deployment update required.</strong> The deployed value lacks:
                  <ul className="mt-1 mb-0 pl-4.5">
                    {uncovered.map((origin) => (
                      <li key={origin}>
                        <Code>{origin}</Code>
                      </li>
                    ))}
                  </ul>
                </WarnBox>
              )}
            </div>
          </Panel>
          <CreateSpaceForm />
        </div>
      </main>
    </>
  );
}

function CreateSpaceForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>(undefined);
  const [fields, setFields] = useState({
    id: "",
    routeClass: "private",
    qualities: "60, 75, 90",
    defaultQuality: "75",
    allowedSourceOrigins: "",
  });
  const create = useMutation({
    mutationFn: async (body: ReturnType<typeof createSpaceBody>) => createSpace({ data: { body } }),
    onError: (cause) => setError(describeThrown(cause)),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(describeFailure(result.failure));
        return;
      }
      await queryClient.invalidateQueries({ queryKey: spaceKeys.all });
      await navigate({
        to: "/spaces/$spaceId",
        params: { spaceId: result.value.space.policy.id },
        search: { generation: result.value.generation },
      });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      create.mutate(createSpaceBody(fields));
    } catch (cause) {
      setError(cause instanceof FormInputError ? cause.message : "The form could not be read.");
    }
  }

  return (
    <Panel id="create">
      <form onSubmit={submit}>
        <PanelHead title="Create a Space">
          <span className="text-ink-3">identifier and class are permanent</span>
        </PanelHead>
        <div className="grid gap-2.5 p-2.5 sm:grid-cols-2">
          <Field label="Identifier" hint={HINTS.identifier}>
            <Input
              name="spaceId"
              required
              pattern="[a-z0-9][a-z0-9_-]*"
              maxLength={64}
              placeholder="my-app"
              value={fields.id}
              onChange={(event) => setFields({ ...fields, id: event.target.value })}
            />
          </Field>
          <Field label="Route class" hint={HINTS.routeClass}>
            <select
              name="routeClass"
              className={INPUT_CLASS}
              value={fields.routeClass}
              onChange={(event) => setFields({ ...fields, routeClass: event.target.value })}
            >
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </Field>
          <Field label="Allowed qualities" hint={HINTS.qualities}>
            <Input
              name="qualities"
              required
              value={fields.qualities}
              onChange={(event) => setFields({ ...fields, qualities: event.target.value })}
            />
          </Field>
          <Field label="Default quality" hint={HINTS.defaultQuality}>
            <Input
              name="defaultQuality"
              required
              inputMode="numeric"
              value={fields.defaultQuality}
              onChange={(event) => setFields({ ...fields, defaultQuality: event.target.value })}
            />
          </Field>
          <Field label="Allowed source origins" hint={HINTS.origins} wide>
            <textarea
              name="allowedSourceOrigins"
              required
              rows={3}
              placeholder={
                "https://uploads.example.com\nhttps://account.r2.cloudflarestorage.com/bucket"
              }
              className={`${INPUT_CLASS} min-h-[52px] resize-y font-mono text-[12px] leading-normal`}
              value={fields.allowedSourceOrigins}
              onChange={(event) =>
                setFields({ ...fields, allowedSourceOrigins: event.target.value })
              }
            />
          </Field>
          {error === undefined ? null : (
            <div className="col-span-full">
              <ErrorNotice>{error}</ErrorNotice>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5">
          <span className="mr-auto text-[11.5px] text-ink-3">Add resolvers on the Space page.</span>
          <Button tone="primary" type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create Space"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
