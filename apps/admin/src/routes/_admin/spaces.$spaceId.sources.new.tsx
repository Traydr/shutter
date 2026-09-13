import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ControlErrorView } from "../../components/error-view";
import { SourceEditor } from "../../features/spaces/SourceEditor";
import { spaceQuery } from "../../features/spaces/spaces-queries";

export const Route = createFileRoute("/_admin/spaces/$spaceId/sources/new")({
  validateSearch: z.object({
    kind: z.enum(["template", "s3"]).default("template"),
    preset: z.enum(["uploadthing"]).optional(),
  }),
  errorComponent: ControlErrorView,
  head: ({ params }) => ({ meta: [{ title: `New source · ${params.spaceId} · Shutter admin` }] }),
  component: NewSourcePage,
});

function NewSourcePage() {
  const { spaceId } = Route.useParams();
  const { kind, preset } = Route.useSearch();
  const detail = useSuspenseQuery(spaceQuery(spaceId)).data;
  return (
    <SourceEditor
      key={`${kind}-${preset ?? ""}`}
      detail={detail}
      mode={{ kind: "new", resolverKind: kind, preset }}
      saved={false}
    />
  );
}
