import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, Outlet, useMatches } from "@tanstack/react-router";
import { ControlErrorView } from "../../components/error-view";
import { AppHeader, type Crumb, type SpaceTab, SpaceTabs } from "../../components/header";
import { ControlReadError, spaceQuery } from "../../features/spaces/spaces-queries";

/** The shell every Space page shares: header with the Space in the crumb, the tab strip, the page. */
export const Route = createFileRoute("/_admin/spaces/$spaceId")({
  loader: async ({ context, params }) => {
    try {
      await context.queryClient.ensureQueryData(spaceQuery(params.spaceId));
    } catch (error) {
      // A Space Control does not know is a 404 page, not a failed read.
      if (error instanceof ControlReadError && error.failure.status === 404) throw notFound();
      throw error;
    }
  },
  errorComponent: ControlErrorView,
  component: SpaceShell,
});

function activeTab(routeIds: readonly string[]): SpaceTab {
  if (routeIds.some((id) => id.includes("/sources"))) return "sources";
  if (routeIds.some((id) => id.includes("/access"))) return "access";
  if (routeIds.some((id) => id.includes("/settings"))) return "settings";
  return "overview";
}

function SpaceShell() {
  const { spaceId } = Route.useParams();
  const detail = useSuspenseQuery(spaceQuery(spaceId)).data;
  const matches = useMatches();
  const active = activeTab(matches.map((match) => match.routeId));
  const id = detail.space.policy.id;
  const crumbs: Crumb[] =
    active === "overview"
      ? [{ label: id }]
      : [{ label: id, link: { to: "/spaces/$spaceId", params: { spaceId: id } } }];
  return (
    <>
      <AppHeader crumbs={crumbs} />
      <SpaceTabs spaceId={id} active={active} />
      <Outlet />
    </>
  );
}
