import type { AdminSpaceDetail } from "@shutter/admin-api";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CopyButton } from "../../components/copy-button";
import { ControlErrorView } from "../../components/error-view";
import {
  Ago,
  Card,
  Day,
  LinkButton,
  Mono,
  PageTitle,
  SectionTitle,
  StateLine,
  Template,
  TextLink,
} from "../../components/ui";
import { SourceList } from "../../features/spaces/SourceList";
import { spaceQuery } from "../../features/spaces/spaces-queries";
import {
  deployment,
  keyRotation,
  originPrefix,
  spaceState,
  withoutScheme,
} from "../../features/spaces/summaries";

export const Route = createFileRoute("/_admin/spaces/$spaceId/")({
  errorComponent: ControlErrorView,
  head: ({ params }) => ({ meta: [{ title: `${params.spaceId} · Shutter admin` }] }),
  component: SpaceOverviewPage,
});

function SpaceOverviewPage() {
  const { spaceId } = Route.useParams();
  const detail = useSuspenseQuery(spaceQuery(spaceId)).data;
  const { policy } = detail.space;
  const active = detail.space.status === "active";
  const state = spaceState(detail);

  return (
    <main className="mx-auto max-w-[1080px] px-6 pb-20 pt-10">
      <div className="mb-7 flex flex-wrap items-baseline gap-4">
        <PageTitle>
          <span className="font-mono">{policy.id}</span>
        </PageTitle>
        <span className="text-fg-2">
          {policy.routeClass === "public" ? "Public" : "Private"} · created{" "}
          <Day value={detail.space.createdAt} />
        </span>
        <StateLine tone={state.tone}>{state.text}</StateLine>
        <span className="flex-1" />
        {active ? (
          <LinkButton to="/spaces/$spaceId/sources" params={{ spaceId }} hash="add">
            Add source
          </LinkButton>
        ) : null}
      </div>

      <section className="mb-7">
        <div className="mb-3 flex items-center gap-3">
          <SectionTitle>Sources</SectionTitle>
          <span className="flex-1" />
          <TextLink to="/spaces/$spaceId/sources" params={{ spaceId }} className="text-[13.5px]">
            Manage
          </TextLink>
        </div>
        <SourceList detail={detail} />
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="grid content-start gap-3.5 px-6 py-5">
          <div className="flex items-center gap-3">
            <SectionTitle>Access</SectionTitle>
            <span className="flex-1" />
            <TextLink to="/spaces/$spaceId/access" params={{ spaceId }} className="text-[13.5px]">
              Manage
            </TextLink>
          </div>
          <AccessSummary detail={detail} />
        </Card>
        <Card className="grid content-start gap-3.5 px-6 py-5">
          <div className="flex items-center gap-3">
            <SectionTitle>Where images may come from</SectionTitle>
            <span className="flex-1" />
            <TextLink to="/spaces/$spaceId/settings" params={{ spaceId }} className="text-[13.5px]">
              Edit
            </TextLink>
          </div>
          <OriginsSummary detail={detail} />
        </Card>
      </div>
    </main>
  );
}

function AccessSummary({ detail }: { detail: AdminSpaceDetail }) {
  const tokens = detail.apiTokens.filter((token) => token.revokedAt === undefined);
  const rotation = keyRotation(detail);
  return (
    <>
      <div className="grid gap-0.5 border-t border-line pt-3">
        <b className="font-medium">API tokens</b>
        <p className="text-[13.5px] leading-relaxed text-fg-2">
          {tokens.length === 0
            ? "None yet. The application needs one to call Control."
            : tokens.map((token, index) => (
                <span key={token.id}>
                  {index === 0 ? "" : " · "}
                  {token.label}
                  {token.lastUsedAt === undefined ? (
                    ", never used"
                  ) : (
                    <>
                      , used <Ago value={token.lastUsedAt} />
                    </>
                  )}
                </span>
              ))}
        </p>
      </div>
      <div className="grid gap-0.5 border-t border-line pt-3">
        <StateLine tone={rotation.tone}>
          <b className="font-medium text-fg">Capability Keys</b>
        </StateLine>
        <p className="text-[13.5px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]">
          {rotation.text}
        </p>
      </div>
    </>
  );
}

function OriginsSummary({ detail }: { detail: AdminSpaceDetail }) {
  const { policy } = detail.space;
  const state = deployment(detail);
  const example = `${detail.edgeBaseUrl ?? ""}/v2/${policy.id}/{source}/{reference}?w=1200&q=${policy.defaultQuality}`;
  return (
    <>
      <p className="text-[13.5px] leading-relaxed text-fg-2 [overflow-wrap:anywhere]">
        {policy.allowedSourceOrigins.map((rule, index) => (
          <span key={originPrefix(rule)}>
            {index === 0 ? "" : " · "}
            {withoutScheme(originPrefix(rule))}
          </span>
        ))}
      </p>
      <StateLine tone={state.tone} className="text-[13.5px] text-fg-2">
        {state.text}
      </StateLine>
      <div className="grid gap-2 border-t border-line pt-3">
        <b className="font-medium">Delivery</b>
        <div className="flex items-center gap-3">
          <Mono className="min-w-0 flex-1 text-fg-2 [overflow-wrap:anywhere]">
            <Template value={withoutScheme(example)} />
          </Mono>
          <CopyButton value={example} />
        </div>
        <span className="text-[13px] text-fg-2">
          Qualities {policy.qualities.join(", ")}; default {policy.defaultQuality}.
        </span>
      </div>
    </>
  );
}
