import type { SpacePolicy } from "@shutter/protocol";

const ernesta = Object.freeze({
  id: "ernesta",
  routeClass: "public",
  qualities: Object.freeze([30, 50, 75]),
  defaultQuality: 75,
  allowedSourceOrigins: Object.freeze([]),
  resolvers: Object.freeze([
    Object.freeze({
      id: "uploadthing",
      type: "uploadthing",
      allowedProjectIds: Object.freeze([]),
    }),
  ]),
}) satisfies SpacePolicy;

const paneView = Object.freeze({
  id: "pane-view",
  routeClass: "private",
  qualities: Object.freeze([30, 75, 80]),
  defaultQuality: 75,
  allowedSourceOrigins: Object.freeze([]),
  resolvers: Object.freeze([] as const),
}) satisfies SpacePolicy;

export const SPACES = Object.freeze({
  ernesta,
  "pane-view": paneView,
});

export type SpaceId = keyof typeof SPACES;

export function getSpacePolicy(spaceId: string): SpacePolicy | undefined {
  if (!Object.hasOwn(SPACES, spaceId)) return undefined;
  return SPACES[spaceId as SpaceId];
}
