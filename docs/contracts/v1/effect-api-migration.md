# Effect API migration

The v1 wire contract is unchanged by the Effect migration. Capability token
bytes, URL shapes, cache identities, and JSON request and response payloads
remain byte-identical.

Only the TypeScript package API changed: fallible protocol operations now
return Effect values with tagged errors. Schema-backed job and executor body
parsers are exported from `@shutter/protocol/jobs`; the edge-safe operations
remain exported from `@shutter/protocol`.
