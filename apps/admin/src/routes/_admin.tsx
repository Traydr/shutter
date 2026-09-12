import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getSessionStatus } from "../features/auth/auth-service";

/** The signed-in shell: every child route is reachable only with a session. */
export const Route = createFileRoute("/_admin")({
  beforeLoad: async () => {
    const { authenticated } = await getSessionStatus();
    if (!authenticated) throw redirect({ to: "/login" });
  },
  component: Outlet,
});
