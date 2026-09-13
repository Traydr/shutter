/**
 * The sentences the pages say about a Space. Every state is one tone and one
 * line of plain language; nothing here mentions registry generations.
 */
import type { AdminOverview, AdminSpace, AdminSpaceDetail } from "@shutter/admin-api";
import type { SourceOriginRule, SourceResolverPolicy } from "@shutter/protocol";

/** The `origin[/path-prefix]` form of one allowed-source rule, as imgproxy and the pages show it. */
export function originPrefix(rule: SourceOriginRule): string {
  const prefix = rule.pathPrefix ?? "";
  return `${rule.origin}${prefix === "/" ? "" : prefix}`;
}

export function withoutScheme(prefix: string): string {
  return prefix.replace(/^https:\/\//u, "");
}

export function kindLabel(resolver: SourceResolverPolicy): string {
  switch (resolver.type) {
    case "template":
      return "URL template";
    case "s3":
      return "S3 bucket";
    case "uploadthing":
      return "UploadThing (retired)";
  }
}

/** Where a resolver fetches from, as one template: the bucket path or the URL. */
export function resolverDestination(resolver: SourceResolverPolicy): string {
  switch (resolver.type) {
    case "uploadthing":
      return resolver.allowedProjectIds.map((id) => `${id}.ufs.sh`).join(", ");
    case "template":
      return resolver.url;
    case "s3": {
      const base = resolver.pathStyle
        ? `${withoutScheme(resolver.endpoint)}/${resolver.bucket}`
        : `${resolver.bucket}.${new URL(resolver.endpoint).host}`;
      return `${base}/${resolver.keyTemplate}`;
    }
  }
}

export type Tone = "ok" | "warn" | "off";

export interface StateSentence {
  tone: Tone;
  text: string;
}

/** What the overview can say about a Space from the overview alone: no tokens, keys, or credentials there. */
export function overviewSpaceState(space: AdminSpace, uncovered: readonly string[]): StateSentence {
  if (space.status !== "active") return { tone: "off", text: "Decommissioned" };
  const missing = space.policy.allowedSourceOrigins
    .map(originPrefix)
    .find((prefix) => uncovered.includes(prefix));
  if (missing !== undefined) {
    return { tone: "warn", text: `${withoutScheme(missing)} isn't deployed yet` };
  }
  return { tone: "ok", text: "Ready" };
}

/** The one thing a Space page should say first, in order of urgency. */
export function spaceState(detail: AdminSpaceDetail): StateSentence {
  const { space } = detail;
  if (space.status !== "active") return { tone: "off", text: "Decommissioned" };
  const missing = detail.coverage.uncovered[0];
  if (missing !== undefined) {
    return { tone: "warn", text: `${withoutScheme(missing)} isn't deployed yet` };
  }
  const uncredentialed = space.policy.resolvers.find(
    (resolver) =>
      resolver.type === "s3" &&
      !detail.resolverCredentials.some((credential) => credential.resolverId === resolver.id),
  );
  if (uncredentialed !== undefined) {
    return { tone: "warn", text: `${uncredentialed.id} has no credential yet` };
  }
  const accepting = detail.capabilityKeys.filter((key) => key.disabledAt === undefined);
  if (accepting.length === 0) return { tone: "warn", text: "No Capability Key yet" };
  if (accepting.length > 1) return { tone: "warn", text: "Key rotation in progress" };
  return { tone: "ok", text: "Ready" };
}

/** The key situation as guidance: what to do next, if anything. */
export function keyRotation(detail: AdminSpaceDetail): StateSentence {
  if (detail.space.status !== "active") {
    return { tone: "off", text: "Keys are read-only records of a decommissioned Space." };
  }
  const accepting = detail.capabilityKeys.filter((key) => key.disabledAt === undefined);
  if (accepting.length === 0) {
    return {
      tone: "warn",
      text: "No key is accepted yet, so the application cannot mint Source Capabilities.",
    };
  }
  if (accepting.length === 1) {
    return { tone: "ok", text: `One key accepted: ${accepting[0]?.keyId ?? ""}.` };
  }
  const newest = accepting.reduce((latest, key) =>
    key.acceptedAt > latest.acceptedAt ? key : latest,
  );
  const older = accepting.filter((key) => key !== newest).map((key) => key.keyId);
  return {
    tone: "warn",
    text: `${accepting.length} keys accepted. Once the application mints with ${newest.keyId} and 24 hours have passed, disable ${older.join(" and ")}.`,
  };
}

/** The imgproxy side of a Space: are its origins in the deployed allowlist? */
export function deployment(detail: AdminSpaceDetail): StateSentence {
  if (detail.space.status !== "active") {
    return { tone: "off", text: "Not part of the allowlist." };
  }
  const total = detail.space.policy.allowedSourceOrigins.length;
  const missing = detail.coverage.uncovered.length;
  if (missing === 0) {
    return {
      tone: "ok",
      text:
        total === 1 ? "It is deployed to the image proxy." : "All are deployed to the image proxy.",
    };
  }
  return {
    tone: "warn",
    text: `${missing === 1 ? "One" : missing} of ${total} ${missing === 1 ? "isn't" : "aren't"} in the deployed allowlist yet.`,
  };
}

export type EdgeState =
  | { kind: "unreported" }
  | { kind: "in-sync"; generation: number; refreshedAt: string }
  | { kind: "behind"; generation: number; refreshedAt: string; lag: number };

export function edgeState(overview: Pick<AdminOverview, "generation" | "edgeRefresh">): EdgeState {
  const refresh = overview.edgeRefresh;
  if (refresh === undefined) return { kind: "unreported" };
  const lag = overview.generation - refresh.generation;
  return lag <= 0
    ? { kind: "in-sync", generation: refresh.generation, refreshedAt: refresh.refreshedAt }
    : { kind: "behind", generation: refresh.generation, refreshedAt: refresh.refreshedAt, lag };
}

export function edgeSentence(
  overview: Pick<AdminOverview, "generation" | "edgeRefresh">,
): StateSentence {
  switch (edgeState(overview).kind) {
    case "unreported":
      return { tone: "warn", text: "The Edge hasn't reported a refresh yet." };
    case "in-sync":
      return { tone: "ok", text: "The Edge is serving your latest changes." };
    case "behind":
      return {
        tone: "warn",
        text: "The Edge hasn't picked up your last change yet. It reloads within a minute.",
      };
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "16 minutes ago", "3 hours ago", "2 days ago"; never in the future. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  const [count, unit] =
    elapsed < HOUR
      ? [Math.max(1, Math.round(elapsed / MINUTE)), "minute"]
      : elapsed < DAY
        ? [Math.round(elapsed / HOUR), "hour"]
        : [Math.round(elapsed / DAY), "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** "Aug 13, 2026" in UTC. */
export function calendarDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
