import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ControlErrorView } from "../../components/error-view";
import { LinkButton, PageTitle, plural } from "../../components/ui";
import { SourceList } from "../../features/spaces/SourceList";
import { spaceQuery } from "../../features/spaces/spaces-queries";

export const Route = createFileRoute("/_admin/spaces/$spaceId/sources/")({
  errorComponent: ControlErrorView,
  head: ({ params }) => ({ meta: [{ title: `Sources · ${params.spaceId} · Shutter admin` }] }),
  component: SourcesPage,
});

function SourcesPage() {
  const { spaceId } = Route.useParams();
  const detail = useSuspenseQuery(spaceQuery(spaceId)).data;
  const active = detail.space.status === "active";
  return (
    <main className="mx-auto max-w-[1080px] px-6 pb-20 pt-10">
      <div className="mb-7 flex flex-wrap items-baseline gap-4">
        <PageTitle>Sources</PageTitle>
        <span className="text-fg-2">
          {plural(detail.space.policy.resolvers.length, "source")} · each turns the reference in a
          request into a place to fetch from
        </span>
      </div>
      <SourceList detail={detail} />
      {active ? (
        <div id="add" className="mt-7 flex flex-wrap items-center gap-3 text-[13.5px] text-fg-2">
          <span>Add a source:</span>
          <LinkButton
            to="/spaces/$spaceId/sources/new"
            params={{ spaceId }}
            search={{ kind: "template" }}
            size="sm"
          >
            URL template
          </LinkButton>
          <LinkButton
            to="/spaces/$spaceId/sources/new"
            params={{ spaceId }}
            search={{ kind: "template", preset: "uploadthing" }}
            size="sm"
          >
            UploadThing
          </LinkButton>
          <LinkButton
            to="/spaces/$spaceId/sources/new"
            params={{ spaceId }}
            search={{ kind: "s3" }}
            size="sm"
          >
            S3 bucket
          </LinkButton>
        </div>
      ) : null}
    </main>
  );
}
