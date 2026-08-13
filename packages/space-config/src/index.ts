import { parseSpacePolicy, type SpacePolicy } from "@shutter/protocol";

// Spaces are the tenants Shutter renders for. Each one pins the storage origins
// its sources may come from, so a compromised or malformed request cannot steer
// imgproxy at an origin the application never authorized.

// A public space: renditions are addressable without a capability token, and an
// UploadThing resolver maps opaque project/file references onto source URLs.
const ernesta = parseSpacePolicy({
  id: "ernesta",
  routeClass: "public",
  qualities: Object.freeze([30, 50, 75]),
  defaultQuality: 75,
  allowedSourceOrigins: Object.freeze([
    Object.freeze({ origin: "https://8w0z32yftd.ufs.sh", pathPrefix: "/f" }),
    Object.freeze({ origin: "https://rrsku8h9ue.ufs.sh", pathPrefix: "/f" }),
  ]),
  resolvers: Object.freeze([
    Object.freeze({
      id: "uploadthing",
      type: "uploadthing",
      allowedProjectIds: Object.freeze(["8w0z32yftd", "rrsku8h9ue"]),
    }),
  ]),
});

// A private space: every rendition requires a capability token issued by the
// owning application, and sources live in one S3-compatible bucket.
const paneView = parseSpacePolicy({
  id: "pane-view",
  routeClass: "private",
  qualities: Object.freeze([30, 75, 80]),
  defaultQuality: 75,
  allowedSourceOrigins: Object.freeze([
    Object.freeze({
      origin: "https://t3.storageapi.dev",
      pathPrefix: "/balanced-wrap-ocyiwwexhao",
    }),
  ]),
  resolvers: Object.freeze([] as const),
});

export const SPACES = Object.freeze({
  ernesta,
  "pane-view": paneView,
});

export type SpaceId = keyof typeof SPACES;

export function getSpacePolicy(spaceId: string): SpacePolicy | undefined {
  if (!Object.hasOwn(SPACES, spaceId)) return undefined;
  return SPACES[spaceId as SpaceId];
}
