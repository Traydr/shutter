/** Explanations shown behind the `?` glyphs; the same wording the runbook uses. */
export const HINTS = {
  generation:
    "The registry generation increments on every Space or policy change. The Edge Worker reports which generation it last loaded, so equal numbers mean the Edge serves current policy.",
  routeClass:
    "Fixed at creation. A public Space serves its resolver sources to anyone. A private Space requires an access token (v2) or a Source Capability (v1) on every request.",
  identifier:
    "Lowercase letters, digits, - and _, up to 64 characters. It appears in every Delivery URL, cannot change, and is never reused after decommissioning.",
  qualities:
    "WebP quality values a Delivery URL may request, comma-separated integers from 1 to 100. Anything outside the list is rejected.",
  defaultQuality: "Used when a Delivery URL omits quality. It must be one of the allowed values.",
  origins:
    "HTTPS origins or path prefixes Shutter may fetch Source Objects from, one per line. These also feed the imgproxy allowlist.",
  resolvers:
    "A Source Resolver turns the reference in a v2 Delivery URL into an allowlisted fetch location. A template expands an HTTPS URL with {placeholders}; an S3 resolver presigns a bucket read with a credential only Control holds. The resolver identifier is part of every Source ID and cannot change.",
  resolverId:
    "Lowercase letters, digits, - and _. It appears in every v2 Delivery URL and in the Source ID of everything the resolver serves, so it cannot change; removing a resolver orphans its cached bytes.",
  templateUrl:
    "An https URL where each {name} stands for one whole path segment or one hostname label. Every expansion must sit inside the Space's allowed source origins.",
  allowed:
    "One line per placeholder that only accepts listed values, as name=value,value. A placeholder in the hostname must have such a line; a path placeholder may.",
  s3Endpoint:
    "The S3-compatible endpoint origin, such as https://<account>.r2.cloudflarestorage.com. Its bucket path must be inside the Space's allowed source origins.",
  keyTemplate:
    "The object key with {name} placeholders, one per /-separated segment, such as originals/{key}.",
  credential:
    "A read-only key pair for this bucket, ideally scoped to the key prefix. It is sealed with the registry encryption key; only the access key ID is shown again. Leave both fields empty on edit to keep the stored pair.",
  testResolver:
    "Resolves the sample reference exactly as a request would, then fetches the first byte from the resulting location with a five-second limit. For an S3 resolver only the host is shown, never the signed URL.",
  apiTokens:
    "Bearer credential the consuming application uses to call Control: create Preview Jobs, request Source Purges. The full token is shown once, when issued.",
  capabilityKeys:
    "Shared symmetric key the application uses to mint Source Capabilities and Shutter uses to accept them. Rotate by adding a new key, installing it in the application, waiting 24 hours, then disabling the old one.",
  allowlist:
    "imgproxy fetches only from IMGPROXY_ALLOWED_SOURCES. This value is derived from every active Space's origins. Copy it into the deployment whenever it changes, keeping any extra Media Store source the deployment needs.",
  decommission:
    "Blocks new Space-scoped work and removes the Space from new Edge snapshots. Keeps the identifier and every audit record. Nothing is deleted, and the identifier is never reused.",
  fixed:
    "To change the identifier or route class, create a new Space, migrate the application to it, then decommission this one.",
} as const;
