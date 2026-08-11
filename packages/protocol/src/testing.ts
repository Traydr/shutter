import type { Effect } from "effect";
import { type IssueCapabilityOptions, issueSourceCapabilityWithIvInternal } from "./capability.js";
import type { CapabilityError } from "./errors.js";
import type { SourceCapabilityClaims } from "./types.js";

export function issueSourceCapabilityWithIv(
  claims: SourceCapabilityClaims,
  options: IssueCapabilityOptions,
  iv: Uint8Array,
): Effect.Effect<string, CapabilityError> {
  return issueSourceCapabilityWithIvInternal(claims, options, iv);
}
