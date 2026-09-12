import { queryOptions } from "@tanstack/react-query";
import { type ControlFailure, type ControlResult, describeFailure } from "../../server/failure";
import { getOverview, getSpace } from "./spaces-service";

/** A read that Control refused, thrown from a query so the route's error view can name it. */
export class ControlReadError extends Error {
  readonly failure: ControlFailure;

  constructor(failure: ControlFailure) {
    super(describeFailure(failure));
    this.name = "ControlReadError";
    this.failure = failure;
  }
}

export function unwrap<T>(result: ControlResult<T>): T {
  if (result.ok) return result.value;
  throw new ControlReadError(result.failure);
}

export const spaceKeys = {
  all: ["spaces"] as const,
  overview: () => [...spaceKeys.all, "overview"] as const,
  detail: (spaceId: string) => [...spaceKeys.all, "detail", spaceId] as const,
};

export const overviewQuery = () =>
  queryOptions({
    queryKey: spaceKeys.overview(),
    queryFn: async () => unwrap(await getOverview()),
  });

export const spaceQuery = (spaceId: string) =>
  queryOptions({
    queryKey: spaceKeys.detail(spaceId),
    queryFn: async () => unwrap(await getSpace({ data: { spaceId } })),
  });
