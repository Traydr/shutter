import type { SourceResolverPolicy, SpacePolicy } from "@shutter/protocol";

export type SpaceStatus = "active" | "decommissioned";

export interface SpaceRecord {
  policy: SpacePolicy;
  status: SpaceStatus;
  createdAt: Date;
  updatedAt: Date;
  decommissionedAt?: Date;
}

/** A read-only S3 credential an operator supplies for one `s3` resolver. */
export interface ResolverCredentialInput {
  resolverId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** What the admin surface may show about a stored credential: never the secret. */
export interface ResolverCredentialSummary {
  resolverId: string;
  accessKeyId: string;
  updatedAt: Date;
}

/** The opened credential, read only by Control's presigner. */
export interface ResolverCredential {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SpacePolicyUpdate
  extends Pick<SpacePolicy, "qualities" | "defaultQuality" | "allowedSourceOrigins"> {
  /**
   * The full resolver list. When absent, the stored resolvers are kept exactly
   * as they are under the Space lock, so a policy edit cannot undo a resolver
   * change that landed between the operator's read and their save.
   */
  resolvers?: SpacePolicy["resolvers"] | undefined;
  /**
   * Credentials for `s3` resolvers in `resolvers`. An `s3` resolver without an
   * entry keeps the credential it already has; a new one must supply it.
   */
  resolverCredentials?: readonly ResolverCredentialInput[] | undefined;
}

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

export interface RegistryGeneration {
  generation: number;
  updatedAt: Date;
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
  createSpace(
    policy: SpacePolicy,
    resolverCredentials?: readonly ResolverCredentialInput[],
  ): Promise<RegistryMutation<SpaceRecord>>;
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
  getGeneration(): Promise<RegistryGeneration>;
  /** The record for a Space of any status; `undefined` only for an unknown identifier. */
  getSpace(spaceId: string): Promise<SpaceRecord | undefined>;
  getActiveSpacePolicy(spaceId: string): Promise<SpacePolicy | undefined>;
  /**
   * Policy and accepted Capability Keys for a Space of any status. An Executor
   * claim may complete work accepted before the Space was decommissioned
   * (ADR 0022), so this read does not filter on status.
   */
  getSpaceAuthorization(spaceId: string): Promise<ActiveSpaceAuthorization | undefined>;
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
  /**
   * Adds, replaces, or removes one resolver under the Space lock, so two
   * operators editing different resolvers cannot overwrite each other.
   */
  editResolver(spaceId: string, change: ResolverChange): Promise<RegistryMutation<SpaceRecord>>;
  listResolverCredentials(spaceId: string): Promise<readonly ResolverCredentialSummary[]>;
  /**
   * The opened credential of one `s3` resolver on a Space of any status, so a
   * claim accepted before decommissioning can still presign (ADR 0022).
   */
  getResolverCredential(
    spaceId: string,
    resolverId: string,
  ): Promise<ResolverCredential | undefined>;
  disableCapabilityKey(
    spaceId: string,
    keyId: string,
  ): Promise<RegistryMutation<CapabilityKeySummary>>;
}

/** One resolver change: the resolver after the change (absent removes it) and its credential. */
export interface ResolverChange {
  resolverId: string;
  resolver?: SourceResolverPolicy | undefined;
  credential?: ResolverCredentialInput | undefined;
  /** Refuse with `conflict` when the identifier is already taken; otherwise it must exist. */
  create?: boolean | undefined;
}

/** The resolver list after one change, with the identifier rules applied. */
export function applyResolverChange(
  policy: SpacePolicy,
  change: ResolverChange,
): readonly SourceResolverPolicy[] {
  const exists = policy.resolvers.some((resolver) => resolver.id === change.resolverId);
  if (change.create === true && exists) {
    throw new SpaceRegistryError("conflict", "a resolver with that identifier already exists");
  }
  if (change.create !== true && !exists) {
    throw new SpaceRegistryError("not_found", "the resolver does not exist");
  }
  if (change.resolver !== undefined && change.resolver.id !== change.resolverId) {
    throw new SpaceRegistryError("invalid", "the resolver identifier cannot change");
  }
  const others = policy.resolvers.filter((resolver) => resolver.id !== change.resolverId);
  return change.resolver === undefined ? others : [...others, change.resolver];
}

/**
 * Which credentials a write stores: the supplied ones, sealed fresh, and the
 * ones to carry over untouched. Only identifiers are needed for the latter,
 * so an adapter never has to open a credential it is not replacing.
 */
export interface ResolverCredentialPlan {
  supplied: ReadonlyMap<string, ResolverCredentialInput>;
  kept: ReadonlySet<string>;
}

const ACCESS_KEY_ID_PATTERN = /^[A-Za-z0-9_\-/+=.]{1,128}$/u;

/**
 * Pairs every `s3` resolver of a policy with its credential: the supplied one
 * when present, otherwise the one already stored under the same resolver ID.
 * Shared by both adapters so the invalid cases have one message each.
 */
export function planResolverCredentials(
  policy: SpacePolicy,
  supplied: readonly ResolverCredentialInput[],
  existing: ReadonlySet<string>,
): ResolverCredentialPlan {
  const s3Resolvers = new Set(
    policy.resolvers.filter((resolver) => resolver.type === "s3").map((resolver) => resolver.id),
  );
  const suppliedById = new Map<string, ResolverCredentialInput>();
  for (const input of supplied) {
    if (!s3Resolvers.has(input.resolverId)) {
      throw new SpaceRegistryError("invalid", `resolver ${input.resolverId} takes no credential`);
    }
    if (!ACCESS_KEY_ID_PATTERN.test(input.accessKeyId)) {
      throw new SpaceRegistryError("invalid", "an S3 access key ID is not valid");
    }
    if (input.secretAccessKey.length === 0 || input.secretAccessKey.length > 256) {
      throw new SpaceRegistryError("invalid", "an S3 secret access key is not valid");
    }
    suppliedById.set(input.resolverId, input);
  }
  const kept = new Set<string>();
  for (const resolverId of s3Resolvers) {
    if (suppliedById.has(resolverId)) continue;
    if (!existing.has(resolverId)) {
      throw new SpaceRegistryError("invalid", `resolver ${resolverId} needs an S3 credential`);
    }
    kept.add(resolverId);
  }
  return { supplied: suppliedById, kept };
}

/** The retired UploadThing kind is still parsed for old snapshots but can no longer be stored. */
export function rejectRetiredResolvers(policy: SpacePolicy): void {
  for (const resolver of policy.resolvers) {
    if (resolver.type === "uploadthing") {
      throw new SpaceRegistryError(
        "invalid",
        `resolver ${resolver.id} uses the retired uploadthing kind; use a template`,
      );
    }
  }
}
