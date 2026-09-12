import { createServerFn } from "@tanstack/react-start";

export interface SessionStatus {
  authenticated: boolean;
}

/** Whether the request holds a live session; a read only, so it never slides the cookie. */
export const getSessionStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionStatus> => {
    const [{ readSession }, { getRequest }] = await Promise.all([
      import("../../server/session-guard"),
      import("@tanstack/react-start/server"),
    ]);
    return { authenticated: readSession(getRequest()) !== undefined };
  },
);
