---
name: shutter
description: Administer a Shutter deployment with the `shutter` CLI — create or edit Spaces, resolvers, API tokens and Capability Keys, and derive the imgproxy allowlist. Use when an application needs to be set up on Shutter, a Space's sources or credentials need changing, or images stop optimizing.
---

# Administering Shutter with the CLI

`shutter` talks to Control's `/v1/admin` API. Credentials are already configured on this machine (`shutter auth status` confirms; exit 1 means ask the user to run `shutter auth login`). Every command takes `--json` for the full admin API document; `shutter --help` lists the rest.

## Set an application up

1. `shutter space create <space> --route-class public|private --origin https://host/path-prefix/` — repeat `--origin` for each place sources live. The identifier and route class can never change.
2. Add a resolver from a JSON document, `shutter resolver set <space> --file resolver.json` (`-` reads stdin). It creates the resolver, or replaces the one with the same `id`:
   - template: `{"resolver":{"id":"media","type":"template","url":"https://host/f/{key}","placeholders":{"key":{}}}}`
   - s3: `{"resolver":{"id":"media","type":"s3","endpoint":"https://…","region":"auto","bucket":"b","pathStyle":true,"keyTemplate":"originals/{key}"},"credential":{"accessKeyId":"…","secretAccessKey":"…"}}` — omit `credential` on a replace to keep the stored pair.
   - Every location a resolver can produce must sit under one of the Space's `--origin` rules.
3. `shutter resolver test <space> <resolver> <segment>...` — exit 0 means the sample reference resolved and its first byte was fetched.
4. `shutter token issue <space> --label <app>` and, for a private Space, `shutter key add <space> <key-id>`. The secret is the only thing on stdout and is shown once: capture it (`TOKEN=$(shutter token issue …)`) and put it straight into the application's secret store. Never print it, commit it, or paste it into a message.
5. `shutter allowlist --check`. Exit 1 means imgproxy cannot read a source yet: the printed value is what `IMGPROXY_ALLOWED_SOURCES` must be (in this repo, `SHUTTER_IMGPROXY_ALLOWED_SOURCES` in `.railway/deployment.env`, then `pnpm deployment:plan`). Changing a deployment variable is the user's call; show them the value and the missing entries.

Done when `resolver test` and `allowlist --check` both exit 0.

## Change or inspect

- `shutter overview`, `shutter space ls`, `shutter space get <space>`, `shutter resolver ls <space>`.
- `shutter space update <space>` changes only the flags given. `--origin` replaces the whole origin list, so pass every origin that should remain.
- Rotate a Capability Key by adding the new one, installing it in the application, and disabling the old one 24 hours later.

## Rules

- `space decommission`, `resolver rm`, and `key disable` refuse without `--yes`. They break live traffic and decommissioning is permanent, so add `--yes` only after the user has confirmed that exact action.
- Images that fail to optimize while sources load fine usually mean an allowlist gap: run `shutter allowlist --check` first.
