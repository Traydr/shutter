import type { SpacePolicy } from "@shutter/protocol";

// Spaces are the tenants Shutter renders for. Each one pins the storage origins
// its sources may come from, so a compromised or malformed request cannot steer
// imgproxy at an origin the application never authorized.

// A public space: renditions are addressable without a capability token, and an
// UploadThing resolver maps opaque project/file references onto source URLs.
const demoPublic = Object.freeze({
  id: "demo-public",
  routeClass: "public",
  qualities: Object.freeze([30, 50, 75]),
  defaultQuality: 75,
  allowedSourceOrigins: Object.freeze([
    Object.freeze({ origin: "https://demo-project-1.ufs.sh", pathPrefix: "/f" }),
    Object.freeze({ origin: "https://demo-project-2.ufs.sh", pathPrefix: "/f" }),
  ]),
  resolvers: Object.freeze([
    Object.freeze({
      id: "uploadthing",
      type: "uploadthing",
      allowedProjectIds: Object.freeze(["demo-project-1", "demo-project-2"]),
    }),
  ]),
}) satisfies SpacePolicy;

// A private space: every rendition requires a capability token issued by the
// owning application, and sources live in one S3-compatible bucket.
const demoPrivate = Object.freeze({
  id: "demo-private",
  routeClass: "private",
  qualities: Object.freeze([30, 75, 80]),
  defaultQuality: 75,
  allowedSourceOrigins: Object.freeze([
    Object.freeze({
      origin: "https://objects.example.com",
      pathPrefix: "/demo-private-bucket",
    }),
  ]),
  resolvers: Object.freeze([] as const),
}) satisfies SpacePolicy;

export const SPACES = Object.freeze({
  "demo-public": demoPublic,
  "demo-private": demoPrivate,
});

export type SpaceId = keyof typeof SPACES;

export function getSpacePolicy(spaceId: string): SpacePolicy | undefined {
  if (!Object.hasOwn(SPACES, spaceId)) return undefined;
  return SPACES[spaceId as SpaceId];
}
