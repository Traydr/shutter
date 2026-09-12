import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { ControlErrorView } from "../../components/error-view";
import { ResolverEditor } from "../../features/spaces/ResolverEditor";
import { spaceQuery } from "../../features/spaces/spaces-queries";

export const Route = createFileRoute("/_admin/spaces/$spaceId/resolvers/$resolverId")({
  validateSearch: z.object({ generation: z.coerce.number().int().nonnegative().optional() }),
  loader: async ({ context, params }) => {
    const detail = await context.queryClient.ensureQueryData(spaceQuery(params.spaceId));
    if (!detail.space.policy.resolvers.some((resolver) => resolver.id === params.resolverId)) {
      throw notFound();
    }
  },
  errorComponent: ControlErrorView,
  head: ({ params }) => ({
    meta: [{ title: `${params.resolverId} · ${params.spaceId} · Shutter admin` }],
  }),
  component: EditResolverPage,
});

function EditResolverPage() {
  const { spaceId, resolverId } = Route.useParams();
  const { generation } = Route.useSearch();
  const detail = useSuspenseQuery(spaceQuery(spaceId)).data;
  const resolver = detail.space.policy.resolvers.find((entry) => entry.id === resolverId);
  if (resolver === undefined) throw notFound();
  return (
    <ResolverEditor
      key={`${spaceId}/${resolverId}`}
      detail={detail}
      mode={{ kind: "edit", resolver }}
      generation={generation}
    />
  );
}
