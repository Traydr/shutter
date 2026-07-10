import { type IssueCapabilityOptions, issueSourceCapabilityWithIvInternal } from "./capability.js";
import type { SourceCapabilityClaims } from "./types.js";

export async function issueSourceCapabilityWithIv(
  claims: SourceCapabilityClaims,
  options: IssueCapabilityOptions,
  iv: Uint8Array,
): Promise<string> {
  return issueSourceCapabilityWithIvInternal(claims, options, iv);
}
