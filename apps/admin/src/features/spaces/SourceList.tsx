import type { AdminSpaceDetail } from "@shutter/admin-api";
import { Chevron, LinkRow, List, Row, Template } from "../../components/ui";
import { kindLabel, resolverDestination } from "./summaries";

/** Every source of a Space, one row each; the retired UploadThing kind has no editor to link to. */
export function SourceList({ detail }: { detail: AdminSpaceDetail }) {
  const { policy } = detail.space;
  const spaceId = policy.id;
  if (policy.resolvers.length === 0) {
    return (
      <p className="text-fg-2">
        No sources yet.
        {detail.space.status === "active"
          ? " Add one so requests to this Space can reach its images."
          : ""}
      </p>
    );
  }
  return (
    <List>
      {policy.resolvers.map((resolver) => {
        const credential = detail.resolverCredentials.find(
          (candidate) => candidate.resolverId === resolver.id,
        );
        const body = (
          <>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 font-medium">
                {resolver.id}
                <span className="text-[13px] font-normal text-fg-3">{kindLabel(resolver)}</span>
              </div>
              <div className="mt-0.5 text-[13px] text-fg-2 [overflow-wrap:anywhere]">
                <Template value={resolverDestination(resolver)} />
                {resolver.type === "s3" && credential === undefined ? (
                  <span className="text-warn-fg"> · no credential yet</span>
                ) : null}
              </div>
            </div>
            {resolver.type === "uploadthing" ? <span /> : <Chevron />}
          </>
        );
        return resolver.type === "uploadthing" ? (
          <Row key={resolver.id}>{body}</Row>
        ) : (
          <LinkRow
            key={resolver.id}
            to="/spaces/$spaceId/sources/$resolverId"
            params={{ spaceId, resolverId: resolver.id }}
          >
            {body}
          </LinkRow>
        );
      })}
    </List>
  );
}
