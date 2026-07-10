# Cloudflare Worker stack

Evaluated 2026-07-10 for the Shutter private capability gateway.

## Selected tools

| Concern | Selection |
| --- | --- |
| Language and module format | TypeScript ES modules |
| HTTP routing | Hono for Cloudflare Workers |
| Runtime | Cloudflare `workerd` |
| Configuration and deployment | Wrangler with `wrangler.jsonc` |
| Local development and build | Vite with `@cloudflare/vite-plugin` |
| Runtime bindings | Generated with `wrangler types` |
| Capability cryptography | Native Web Crypto AES-GCM |
| Private edge caching | Workers Cache API with synthetic canonical Request keys |
| Secrets | Required Worker secret bindings, never plaintext `vars` |
| Tests | Vitest with `@cloudflare/vitest-pool-workers` |

Cloudflare recommends `wrangler.jsonc` for new projects and treats it as the
Worker configuration source of truth. Compatibility dates are pinned and
updated deliberately. Runtime bindings are generated from that exact date and
flags with `wrangler types` rather than manually approximated.

The official Vite plugin runs Worker code in `workerd`, closely matching
production while supporting a standalone Worker. The Worker uses Hono's standard
module-worker entry point and reads typed bindings from `c.env`.

Sources:

- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Workers TypeScript guidance](https://developers.cloudflare.com/workers/languages/typescript/)
- [Hono on Cloudflare Workers](https://hono.dev/docs/getting-started/cloudflare-workers)

## Runtime boundary

The edge and shared capability packages use Web Standards only: `Request`,
`Response`, `URL`, `Uint8Array`, `TextEncoder`, `crypto.subtle`, and the Cache
API. They do not import `node:*`, use `Buffer`, access `process.env`, or enable
`nodejs_compat` in v1. Node 22 also exposes Web Crypto, allowing capability
fixtures and algorithms to be shared with Shutter Control and consumer server
packages without a Node-specific crypto implementation.

AES-GCM is supported natively by the Workers Web Crypto implementation. Secrets
are declared as required bindings in `wrangler.jsonc`, provisioned outside the
repository, and read through the Hono binding environment.

Sources:

- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)

## Tests required

Cloudflare recommends its Vitest integration because it runs tests inside the
Workers runtime with actual bindings. Shutter's edge suite must cover:

- AES-GCM encrypt/decrypt compatibility with Node-generated fixtures.
- Rejection of tampering, wrong key IDs, wrong purpose, expiry, and route-policy
  mismatch.
- Canonical keys remaining stable across capability renewal and key rotation.
- Cache hits authorizing before lookup on private routes.
- Origin misses including the Worker-to-origin credential.
- Public and private routes never sharing cache namespaces.

Source: [Cloudflare Workers testing](https://developers.cloudflare.com/workers/testing/).

## Deliberately excluded from v1

- D1, KV, Durable Objects, Queues, and R2.
- Node compatibility and Node-only middleware.
- Framework-managed Worker configuration in place of `wrangler.jsonc`.
- Cloudflare Images transformations; imgproxy remains the renderer.
