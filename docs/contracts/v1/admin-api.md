# Admin API

Control exposes the Space Registry to operators as JSON under `/v1/admin`. The
admin application calls it from its server; an operator script can call it
with `curl`. It is the same Space Registry contract Control's runtime routes
use, so the two cannot disagree about what a Space is.

## Authentication

Every route requires `Authorization: Bearer <ADMIN_API_TOKEN>`. The token is a
deployment variable of at least 32 characters, compared in constant time.
While it is unset, every route answers `401`. There is no session and no
CSRF: the caller is a service, and the browser never holds this token.

## Routes

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /v1/admin/overview` | | `AdminOverview` |
| `POST /v1/admin/spaces` | `CreateSpaceRequest` | `201` `SpaceMutation` |
| `GET /v1/admin/spaces/{spaceId}` | | `AdminSpaceDetail` |
| `PUT /v1/admin/spaces/{spaceId}/policy` | `UpdateSpacePolicyRequest` | `SpaceMutation` |
| `POST /v1/admin/spaces/{spaceId}/decommission` | | `SpaceMutation` |
| `POST /v1/admin/spaces/{spaceId}/resolvers` | `ResolverRequest` | `201` `SpaceMutation` |
| `PUT /v1/admin/spaces/{spaceId}/resolvers/{resolverId}` | `ResolverRequest` | `SpaceMutation` |
| `DELETE /v1/admin/spaces/{spaceId}/resolvers/{resolverId}` | | `SpaceMutation` |
| `POST /v1/admin/spaces/{spaceId}/resolvers/{resolverId}/test` | `{ reference: string[] }` | `ResolverTestResult` |
| `POST /v1/admin/spaces/{spaceId}/api-tokens` | `{ label }` | `201` `IssuedApiToken` |
| `POST /v1/admin/spaces/{spaceId}/api-tokens/{tokenId}/revoke` | | `ApiTokenMutation` |
| `POST /v1/admin/spaces/{spaceId}/capability-keys` | `{ keyId }` | `201` `IssuedCapabilityKey` |
| `POST /v1/admin/spaces/{spaceId}/capability-keys/{keyId}/disable` | | `CapabilityKeyMutation` |

The schemas live in `@shutter/admin-api` (`packages/admin-api/src/wire.ts`)
with a typed client. A request body is `application/json`, at most 32 KiB,
and strict: an unknown field is rejected. Every timestamp is an ISO instant.

## Rules

- Every mutation answers with `generation`, the registry generation it
  produced, and the Space as stored. A policy update never touches the
  resolver list; resolvers have their own routes.
- A resolver's `id` in a `PUT` body must equal the path's `resolverId`.
  `POST` creates and answers `409` when the identifier exists; `PUT` replaces
  and answers `404` when it does not. On a replace, an absent `credential`
  keeps the stored S3 pair.
- The secret of an API token or Capability Key travels once, as `secret` in
  the `201` body of the request that issued it. Control answers that body from
  the mutation result alone and reads nothing after the commit, so a failing
  read cannot lose a stored credential. No later response contains it.
- A resolver test resolves the sample reference as a request would and fetches
  its first byte. The answer names the host, never the signed location.
- Responses are `Cache-Control: private, no-store`.

## Errors

Errors are the v2 problem format ([../v2/errors.md](../v2/errors.md)) with
one addition: `detail` names the rejected input in the registry's own words,
such as `defaultQuality must be one of the permitted qualities`. Codes:
`unauthorized` (401), `request_invalid` (400), `not_found` (404), `conflict`
(409), `payload_too_large` (413), `service_unavailable` (503).
