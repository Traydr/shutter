import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ControlErrorView } from "../../components/error-view";
import { ResolverEditor } from "../../features/spaces/ResolverEditor";
import { spaceQuery } from "../../features/spaces/spaces-queries";

export const Route = createFileRoute("/_admin/spaces/$spaceId/resolvers/new")({
  validateSearch: z.object({
    kind: z.enum(["template", "s3"]).default("template"),
    preset: z.enum(["uploadthing"]).optional(),
  }),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(spaceQuery(params.spaceId)),
  errorComponent: ControlErrorView,
  head: ({ params }) => ({ meta: [{ title: `New resolver · ${params.spaceId} · Shutter admin` }] }),
  component: NewResolverPage,
});

function NewResolverPage() {
  const { spaceId } = Route.useParams();
  const { kind, preset } = Route.useSearch();
  const detail = useSuspenseQuery(spaceQuery(spaceId)).data;
  return (
    <ResolverEditor
      key={`${kind}-${preset ?? ""}`}
      detail={detail}
      mode={{ kind: "new", resolverKind: kind, preset }}
      generation={undefined}
    />
  );
}
