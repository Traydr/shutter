import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  expandPublicResolver,
  expandS3Resolver,
  ProtocolError,
  parseSourceReference,
  type S3ResolverPolicy,
  type SpacePolicy,
  validateSourceLocator,
} from "@shutter/protocol";
import type { ResolverCredential, SpaceRegistry } from "./spaces/registry.js";

/** How long a presigned locator minted for an optimization or delivery miss stays valid. */
export const RESOLVE_LIFETIME_SECONDS = 10 * 60;

export interface ResolveInput {
  policy: SpacePolicy;
  resolverId: string;
  reference: readonly string[];
  /** For an S3 resolver, the presign lifetime; a template locator does not expire. */
  lifetimeSeconds: number;
  now: Date;
}

export type Resolution =
  | { outcome: "resolved"; sourceId: string; locator: string; expiresAt: Date }
  /** No such resolver on the Space, or a reference outside its grammar. */
  | { outcome: "not_found" }
  /** The expansion left the Space's allowed origins; the policy parser should have refused it. */
  | { outcome: "not_allowed" }
  /** An `s3` resolver without a usable credential. */
  | { outcome: "configuration_error" };

/**
 * The one place Control turns a resolver reference into a fetch location
 * (ADR 0025). Templates expand in memory; S3 references are presigned with the
 * resolver's credential, which never leaves this process.
 */
export interface SourceResolverService {
  resolve(input: ResolveInput): Promise<Resolution>;
}

export interface S3PresignInput {
  resolver: S3ResolverPolicy;
  credential: ResolverCredential;
  key: string;
  expiresInSeconds: number;
}

export interface S3Presigner {
  presign(input: S3PresignInput): Promise<string>;
}

/** Presigns with the AWS SDK, keeping one client per endpoint, region, style, and access key. */
export function createS3Presigner(): S3Presigner {
  const clients = new Map<string, S3Client>();
  return {
    presign({ resolver, credential, key, expiresInSeconds }) {
      const clientKey = [
        resolver.endpoint,
        resolver.region,
        String(resolver.pathStyle),
        credential.accessKeyId,
        credential.secretAccessKey,
      ].join("\n");
      let client = clients.get(clientKey);
      if (client === undefined) {
        client = new S3Client({
          endpoint: resolver.endpoint,
          region: resolver.region,
          forcePathStyle: resolver.pathStyle,
          credentials: {
            accessKeyId: credential.accessKeyId,
            secretAccessKey: credential.secretAccessKey,
          },
        });
        clients.set(clientKey, client);
      }
      return getSignedUrl(client, new GetObjectCommand({ Bucket: resolver.bucket, Key: key }), {
        expiresIn: expiresInSeconds,
      });
    },
  };
}

export interface SourceResolverDependencies {
  credentials: Pick<SpaceRegistry, "getResolverCredential">;
  presigner: S3Presigner;
}

export function createSourceResolverService(
  dependencies: SourceResolverDependencies,
): SourceResolverService {
  return {
    async resolve(input) {
      const resolver = input.policy.resolvers.find(
        (candidate) => candidate.id === input.resolverId,
      );
      if (resolver === undefined) return { outcome: "not_found" };
      const reference = parseSourceReference(resolver, input.reference);
      if (reference === undefined) return { outcome: "not_found" };

      let locator: string;
      if (resolver.type === "s3") {
        const credential = await dependencies.credentials.getResolverCredential(
          input.policy.id,
          resolver.id,
        );
        if (credential === undefined) return { outcome: "configuration_error" };
        locator = await dependencies.presigner.presign({
          resolver,
          credential,
          key: expandS3Resolver(resolver, reference.values).key,
          expiresInSeconds: input.lifetimeSeconds,
        });
      } else {
        locator = expandPublicResolver(resolver, reference.values);
      }

      try {
        validateSourceLocator(locator, input.policy.allowedSourceOrigins);
      } catch (error) {
        if (error instanceof ProtocolError) return { outcome: "not_allowed" };
        throw error;
      }
      return {
        outcome: "resolved",
        sourceId: reference.sourceId,
        locator,
        expiresAt: new Date(input.now.getTime() + input.lifetimeSeconds * 1_000),
      };
    },
  };
}
