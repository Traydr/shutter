import type { SpacePolicy } from "@shutter/protocol";

export type SpaceStatus = "active" | "decommissioned";

export interface SpaceRecord {
  policy: SpacePolicy;
  status: SpaceStatus;
  createdAt: Date;
  updatedAt: Date;
  decommissionedAt?: Date;
}

export type SpacePolicyUpdate = Pick<
  SpacePolicy,
  "qualities" | "defaultQuality" | "allowedSourceOrigins" | "resolvers"
>;

export interface ApiTokenSummary {
  id: number;
  label: string;
  displayPrefix: string;
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export interface CapabilityKeySummary {
  id: number;
  keyId: string;
  acceptedAt: Date;
  disabledAt?: Date;
}

export interface IssuedApiToken extends ApiTokenSummary {
  token: string;
}

export interface IssuedCapabilityKey extends CapabilityKeySummary {
  key: string;
}

export interface RegistryMutation<T> {
  generation: number;
  value: T;
}

export interface EdgeSpaceSnapshot {
  schemaVersion: "v1";
  generation: number;
  registryUpdatedAt: Date;
  spaces: readonly SpacePolicy[];
  capabilityKeys: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>;
}

export interface ActiveSpaceAuthorization {
  policy: SpacePolicy;
  capabilityKeys: ReadonlyMap<string, Uint8Array>;
}

/**
 * The one answer to "may this request act on this Space?". `missing` is
 * returned only after a successful query confirmed the active Space does not
 * exist — a registry failure throws instead, so the caller cannot fail open.
 */
export type SpaceRequestAuthorization =
  | { outcome: "missing" }
  | { outcome: "unauthorized" }
  | ({ outcome: "authorized" } & ActiveSpaceAuthorization);

export type SpaceRegistryErrorCode = "conflict" | "invalid" | "not_found" | "unavailable";

export class SpaceRegistryError extends Error {
  readonly code: SpaceRegistryErrorCode;

  constructor(code: SpaceRegistryErrorCode, message: string) {
    super(message);
    this.name = "SpaceRegistryError";
    this.code = code;
  }
}

export interface SpaceRegistryTransaction {
  loadEdgeSnapshot(): Promise<EdgeSpaceSnapshot>;
  createSpace(policy: SpacePolicy): Promise<RegistryMutation<SpaceRecord>>;
  issueApiToken(
    spaceId: string,
    label: string,
    token?: string,
  ): Promise<RegistryMutation<IssuedApiToken>>;
  verifyApiToken(spaceId: string, token: string): Promise<boolean>;
  addCapabilityKey(
    spaceId: string,
    keyId: string,
    key?: Uint8Array,
  ): Promise<RegistryMutation<IssuedCapabilityKey>>;
}

export interface SpaceRegistry extends SpaceRegistryTransaction {
  withTransaction<T>(work: (registry: SpaceRegistryTransaction) => Promise<T>): Promise<T>;
  getActiveSpacePolicy(spaceId: string): Promise<SpacePolicy | undefined>;
  getActiveSpaceAuthorization(spaceId: string): Promise<ActiveSpaceAuthorization | undefined>;
  authorizeSpaceRequest(
    spaceId: string,
    token: string | undefined,
  ): Promise<SpaceRequestAuthorization>;
  listSpaces(): Promise<readonly SpaceRecord[]>;
  editSpace(spaceId: string, update: SpacePolicyUpdate): Promise<RegistryMutation<SpaceRecord>>;
  decommissionSpace(spaceId: string): Promise<RegistryMutation<SpaceRecord>>;
  listApiTokens(spaceId: string): Promise<readonly ApiTokenSummary[]>;
  revokeApiToken(spaceId: string, tokenId: number): Promise<RegistryMutation<ApiTokenSummary>>;
  listCapabilityKeys(spaceId: string): Promise<readonly CapabilityKeySummary[]>;
  disableCapabilityKey(
    spaceId: string,
    keyId: string,
  ): Promise<RegistryMutation<CapabilityKeySummary>>;
}
