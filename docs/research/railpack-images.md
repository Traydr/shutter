# Railpack images

Evaluated 2026-10-15 for the size and startup of the four Node services Railway
builds with Railpack (Control, Admin, and the video and PDF Executors), and for
whether to replace Railpack with per-service Dockerfiles.

## Decision

Keep Railpack for now, and take the wins it allows:

- Start every service's built entrypoint with `node`, not `pnpm --filter … start`.
- Set `RAILPACK_PRUNE_DEPS=true` on every Node service.
- Add a root `railpack.json` that pins pnpm and keeps pnpm's registry-metadata
  cache out of the image.

Together these roughly halve Control and Admin and cut a third from each
Executor (table below). They also make SIGTERM reach Node directly and fix a
latent build failure for fresh deployments.

Moving the two Executors to Dockerfiles is the next large win (the video image
would drop by about half again). It is a recommendation, not part of this
change, for the reasons in [Recommendation](#recommendation).

## How Railpack builds a service here

Railway's build log for the 2026-10-08 deploy names Railpack 0.40.1 with the
`mise-2026.9.15` builder and runtime images. I reproduced that build locally with
the same CLI and BuildKit. The plan has these steps:

| Step | Base | What it does |
| --- | --- | --- |
| `packages:mise` | `railpack-builder` (Debian trixie) | mise installs Node 24.21.0 and pnpm |
| `install` | previous step | copies only manifests, runs `pnpm add -g node-gyp`, then `pnpm install --frozen-lockfile --prefer-offline` for all 13 workspace projects, devDependencies included |
| `prune` | `install` | only with `RAILPACK_PRUNE_DEPS`: `pnpm prune --prod --ignore-scripts` |
| `build` | `install` + source | the service's custom build command, e.g. `pnpm --filter @shutter/control... build` |
| `packages:apt:runtime` | `railpack-runtime` (`debian:trixie-slim`) | `apt-get update && apt-get install -y <RAILPACK_DEPLOY_APT_PACKAGES>` |
| deploy | `packages:apt:runtime` | copies `/mise/{shims,installs}`, `/usr/local/bin/mise`, `/app/node_modules` (from `build`, or from `prune`), and from `build` both `/root/.cache` and all of `/app` except the root `node_modules` |

The deploy image runs `["/bin/bash", "-c"]` with the start command as its only
argument. Railway documents that a Railpack start command "is ran in a shell
process". Bash `exec`s a single simple command, so PID 1 is whatever the
command names.

The image environment fixes `CI=true`, `NODE_ENV=production`, `PNPM_HOME`, the
`MISE_*` paths, and a `PATH` that starts with `/app/node_modules/.bin:/mise/shims`.
The `CI=true` matters for the Admin application (see
[Start commands and signals](#start-commands-and-signals)).

### pnpm version detection

Railpack takes pnpm's version from the lockfile's first line. pnpm 12 starts
`pnpm-lock.yaml` with a `---` document marker, so Railpack 0.40.1 and 0.41.0
both log `could not detect pnpm lockfile version` and fall back to pnpm 9.
Railpack never reads `packageManager` for pnpm, only for Yarn.

Production still gets 12.10.1, but only because Railway passes the previous
build's versions back to Railpack (`--previous`). A first build of a fresh
service resolves pnpm 9.15.9. mise's shim then switches to 12.10.1 inside
`/app` because of `packageManager`. Railpack did not put pnpm 11+'s
`/opt/pnpm/bin` on `PATH` for pnpm 9, so `pnpm add -g node-gyp` fails with
`ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH`. I reproduced that failure.

`railpack.json` now pins `packages.pnpm`, and a configuration test keeps that
pin equal to `packageManager`.

## What ships today

Measured on `linux/amd64`, the production architecture. Sizes are the
uncompressed filesystem (`du -sx /`) and, after the slash, the compressed size
Docker reports. All figures are MB.

| Image | Total | `node_modules` | pnpm metadata cache | `/mise` | apt packages |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control, today | 1,535 / 444 | 870 | 166 | 390 | none |
| Admin, today | 1,537 / 444 | 870 | 166 | 390 | none |
| Video, today | 1,953–2,001 / 608–638 | 701–870 | 122–166 | 390 | ffmpeg, 632 |
| PDF, today | 1,988–2,036 / 621–650 | 701–870 | 122–166 | 390 | ffmpeg + poppler, 667 |
| Control, this change | 708 / 203 | 208 | 1 | 390 | none |
| Admin, this change | 710 / 203 | 208 | 1 | 390 | none |
| Video, this change | 1,339 / 436 | 208 | 1 | 390 | ffmpeg, 632 |
| PDF, this change | 1,374 / 448 | 208 | 1 | 390 | ffmpeg + poppler, 667 |
| Video, Dockerfile experiment | 697 / 244 | 29 | 0 | none (Node in base) | ffmpeg without recommends, 434 |

The "today" ranges come from repeated builds. `workerd`'s postinstall sometimes
copies its 134 MB binary into the package, and pnpm's metadata cache varies.
Both disappear with this change.

The audit's two findings hold:

- **The whole workspace's `node_modules` ships in every image.** That is 701 to
  870 MB on Linux, devDependencies included. The largest packages are
  `workerd` (129 to 263 MB), Biome (64), the native TypeScript compiler (27),
  Miniflare (25), the Railway CLI (21), rolldown (19), two sharp libvips builds
  (18 each), and Wrangler (15). None runs in production.
- **apt installs recommended packages.** Railpack's command is
  `apt-get install -y` with no `--no-install-recommends`, and no setting changes
  it. Debian's slim base doesn't disable recommends either. The production log
  shows mesa, Vulkan, VA-API and VDPAU drivers, libllvm19, GTK, PulseAudio and
  systemd arriving with ffmpeg.

The other fixed costs:

- `/mise` is 390 MB in every image: Node 24.21.0 (204 MB), pnpm 12.10.1
  (57 MB) and the mise binary itself (130 MB). The whole `node:24-trixie-slim`
  image is 234 MB.
- The `railpack-runtime` base is 106 MB with 86 packages.
- `/root/.cache/pnpm` held 122 to 166 MB of npm registry metadata. pnpm
  fetches it for the `minimumReleaseAge` supply-chain check, and Railpack copies
  `/root/.cache` into the image.

## apt package sets

Measured by installing on `railpack-runtime:mise-2026.9.15` (amd64).

| Packages | With recommends (Railpack) | `--no-install-recommends` |
| --- | ---: | ---: |
| `ffmpeg` | +632 MB, 281 packages | +434 MB, 207 packages |
| `ffmpeg poppler-utils` | +667 MB, 318 packages | +455 MB, 240 packages |
| `poppler-utils` | +62 MB, 84 packages | +46 MB, 74 packages |
| `poppler-utils webp` | +341 MB, 123 packages | +245 MB, 111 packages |
| `webp` | not measured | +206 MB, 54 packages |

Debian's `webp` package is not a light encoder. `vwebp`, a viewer, depends on
freeglut and the Mesa GL stack.

## Start commands and signals

Measured with the Railpack images: native `linux/arm64` for timings, amd64 for
behavior.

OrbStack's Rosetta emulation injects `--no-opt -r /proc/.p` into every amd64
`node`, so amd64 timings here are not meaningful. Cold start is the time from
`docker run` to the first `/healthz` answer, as the median of five runs.

| | Through `pnpm --filter … start` | `node <entrypoint>` |
| --- | --- | --- |
| Processes | pnpm as PID 1 (28 MiB RSS native, 49 MiB under emulation), an `sh -c` wrapper, a watchdog `sh` that SIGKILLs the child's process group if pnpm dies, then Node | Node as PID 1 |
| SIGTERM | pnpm 12 forwards it and waits; a probe that took 3 s to shut down finished | delivered directly |
| Exit after SIGTERM | Node exits 0, pnpm exits 1 with `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` | 0 |
| Control cold start | 0.340 s | 0.296 s (0.285 s pruned) |
| Video Executor cold start | 0.257 s | 0.221 s (0.252 s pruned, noisy) |

So signal delivery through pnpm 12 works, despite Railway's generic advice. The
change still buys 30 to 50 MiB less per service, about 40 ms per cold start, a
clean exit code, and no error at every Executor sleep. Production logs that
error 1.8 s after each "Stopping Container".

Railway's own troubleshooting page recommends starting Node directly.

Changing the start command has these consequences:

- **Commands run from `/app`, the repository root.** `node
  apps/control/dist/index.js` works because no entrypoint reads paths relative
  to the working directory. Migrations resolve `../drizzle` from
  `import.meta.url`, and Nitro resolves its public assets from its own file.
- **Control's `npm_package_version` is no longer set.** Its logger falls back to
  `0.1.0`, which is the value pnpm set, and `service.version` prefers
  `RAILWAY_GIT_COMMIT_SHA` anyway.
- **The Admin application needs `env -u CI`.**
  - srvx, Nitro 3's server, installs its SIGTERM handler only when neither `CI`
    nor `TEST` is set, and Railpack bakes `CI=true` into the image.
  - Through pnpm, Admin died on the forwarded signal with no drain.
  - As bare PID 1 it would ignore SIGTERM entirely, because Linux drops signals
    with no handler for PID 1. `docker stop` then waited 20 s and SIGKILLed it,
    exit 137.
  - With `env -u CI` (`env` `exec`s Node, which stays PID 1), srvx drains and
    the process exits 0 in about 1 s. Only srvx reads `CI` in the Admin bundle.
- **Railway's default draining time is 0 s.** A redeploy sends SIGKILL right
  after SIGTERM unless a service sets `drainingSeconds`. Control sets 15 s and
  imgproxy now sets 50 s. Admin and the Executors set none.

## Railpack settings

### `RAILPACK_PRUNE_DEPS`

The `prune` step runs `pnpm prune --prod --ignore-scripts` on the install
output, in parallel with the build. pnpm's documentation says prune does not
support monorepos. In practice, pnpm 12 here removes the root devDependencies
and their dependencies (`+7 -466`, 870 MB to 208 MB). It keeps every workspace
project's production dependencies, because they share one virtual store.

Symlinks to workspace devDependencies such as `typescript` or `vitest` dangle,
which is harmless at runtime. Anything the build writes into `/app/node_modules`
is discarded, and none of our builds rely on that.

I checked the pruned images:

- **Control:** ran `node apps/control/dist/migrate.js` against a throwaway
  Postgres 17. Fully configured, it answered `/healthz`, `/v1/admin/overview`
  and `/internal/v1/edge/config` from that database, then logged
  `control.service.stopping` and exited 0 on SIGTERM.
- **Executors:** both start, find `ffmpeg`, `ffprobe`, `pdfinfo` and `pdftoppm`,
  and exit 0 on SIGTERM.
- **Admin:** serves its assets.

What prune cannot do:

- Drop production dependencies the service doesn't use. Every image still
  carries Control's AWS SDK, OpenTelemetry and Drizzle, and Admin's React and
  Nitro, about 208 MB in all.
- Leave out `node_modules` for Admin, whose `.output` is fully bundled and
  imports only `node:` built-ins.

### Install command

Setting `RAILPACK_INSTALL_CMD` to a filtered install
(`pnpm install --filter @shutter/<svc>...`) would trim further. I rejected it:

- Railpack replaces the install step with `COPY .` plus `sh -c`, so every source
  change invalidates the install layer.
- The step loses Railpack's `PATH` entry and its `node-gyp` install.
- The assets build still needs sharp, a devDependency.

### `RAILPACK_DEPLOY_APT_PACKAGES`

These packages go into the runtime base. `RAILPACK_BUILD_APT_PACKAGES` would put
them in the builder only. The list replaces Railpack's own runtime list unless
it contains `...`. Here that drops only `libatomic1`, which Node 24 doesn't need
and ffmpeg pulls in anyway. Recommends cannot be turned off (see above).

### `railpack.json`

Railpack reads `railpack.json` at the repository root, or the file
`RAILPACK_CONFIG_FILE` names. Its settings override `RAILPACK_*` variables,
which override CLI options.

Two behaviors matter here:

- **`packages.pnpm` sets the resolved pnpm version.** That fixes the PATH
  layout and the fresh-build failure described above.
- **Naming a generated step in `steps` adds that step's `/app` to the deploy
  inputs.** Without `"deployOutputs": []` on `install`, the unpruned 870 MB
  `node_modules` came back. The configuration test pins the whole `steps`
  object for this reason.

`PNPM_CONFIG_CACHE_DIR=/tmp/pnpm-cache` (pnpm 11+ reads `pnpm_config_*`, never
`npm_config_*`) moves the metadata cache to a path Railpack doesn't copy.

### Caching

Railpack mounts BuildKit caches for the pnpm store (`/opt/pnpm/store`), apt, and
Vite. The layer cache keys on each step's inputs; the install step copies only
manifests, so a source-only change reuses the installed `node_modules`.
Railway doesn't document whether the four services share caches, and "cache
hit on builds is not guaranteed".

### Custom start commands

A custom start command replaces Railpack's own detection (`Custom start command
detected`), lands in the image `CMD`, and runs under `bash -c`. It changes
nothing about what is installed or copied.

## The PDF Executor's encoder

The PDF Executor renders page one with `pdftoppm -scale-to`, already sized to
fit the 1920 × 1920 Master Preview box, and pipes the PPM into ffmpeg only to
encode WebP with libwebp. The dimensions come from the WebP header, not
`ffprobe`. ffmpeg is therefore 605 of the PDF image's 667 MB of apt packages,
used for one encode.

A static `cwebp` would replace all of that:

- Google's prebuilt libwebp 1.6.0 for Linux x86-64 includes `cwebp`, a 4.9 MB
  statically linked binary.
- It reads PPM from a file or from stdin.
- At quality 90 it produced output byte-identical to ffmpeg's libwebp for a
  1920 × 2714 test page (137,666 bytes each).

Rendering and dimension reading already work without ffmpeg, so switching
needs one code change: pipe the PPM into `cwebp -q 90 -o <out> -- -` instead of
ffmpeg's encoder, keeping the same encoder options.

The image then needs only poppler (46 to 62 MB) plus `cwebp`. Railpack can't
install a pinned binary download cleanly, so this belongs with a Dockerfile.

## Dockerfile alternative

I built this experiment for the video Executor from a clean export of `main`.
It started, answered `/healthz`, ran as Node PID 1, and exited 0 on SIGTERM:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-trixie-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN --mount=type=cache,id=s/<service id>-/root/.local/share/pnpm/store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@shutter/executor-video..."
RUN pnpm --filter "@shutter/executor-video..." build
RUN pnpm --filter @shutter/executor-video deploy --prod --legacy /out \
 && rm -rf /out/src /out/*.test.* /out/tsconfig*.json

FROM node:24-trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
```

The result was 697 MB uncompressed and 244 MB compressed, against 1,339 / 436
for the pruned Railpack image. The service directory was 30 MB.

Using it on Railway means:

- **Builder:** `build: { builder: "DOCKERFILE", dockerfilePath:
  "apps/executor-video/Dockerfile" }` in `railway.ts`, with no `start`, because
  Railway runs a Dockerfile service's start command in exec form, overriding
  `ENTRYPOINT`.
- **No root `Dockerfile`:** Railway builds with a Dockerfile whenever it finds
  one, which would capture every service.
- **Cache mount IDs:** they need the literal `s/<service id>-` prefix, and they
  cannot use variables.
- **Watch patterns:** add the Dockerfile's path.
- **pnpm pin:** `corepack enable` reads `packageManager`, so it stays in one
  place. Node 25 drops corepack.
- **`pnpm deploy`:** it needs `--legacy` unless the workspace sets
  `inject-workspace-packages`.

Estimates for the other services from the measured parts (234 MB base, 30 MB
app, the apt sizes above):

| Service | Estimate |
| --- | --- |
| PDF with poppler and `cwebp` | about 315 MB |
| PDF with poppler and ffmpeg, no recommends | about 720 MB |
| Admin, whose bundled `.output` needs no `node_modules` | about 240 MB |
| Control | about 330 MB, depending on its production dependency tree |

A bundled entrypoint (esbuild or rolldown into one file) would shrink the
service directory further. It adds a bundler step and source-map decisions for a
few tens of MB, so `pnpm deploy` is the better first step.

## Recommendation

1. **Done in this change.** The Railpack changes above are low-risk, guarded
   by configuration tests, and visible in one read-only `railway config plan`.
   They take Control and Admin from about 1.5 GB to 0.7 GB and the Executors
   from about 2.0 GB to 1.35 GB.
2. **Next, for the owner to decide: Dockerfiles for the two Executors.** They
   sleep, so they start more often than anything else, and they carry the
   largest images. Expect about 700 MB for video and about 315 MB for PDF once
   it uses `cwebp`. I left this as a recommendation because:
   - it changes the builder for two services, which deserves its own ADR;
   - it pins a downloaded `cwebp` binary by checksum;
   - the PDF Executor's encoder has to move from ffmpeg to `cwebp`, as above;
   - only a real Railway deploy can confirm the cache-mount IDs, watch patterns
     and wake behavior.
3. **Control and Admin can stay on Railpack.** Control is always on and Admin
   is rarely used, so their remaining fixed `/mise` layer costs disk and
   registry space, not user latency.

Whether a smaller image shortens Railway's wake from sleep is inferred, not
measured. A slept service keeps its slot, so its image is probably still on the
host; image size matters when Railway reschedules it.

## Method

- Railpack 0.40.1 CLI (the version Railway's log names) against a local BuildKit
  daemon in Docker.
- Builds used a clean `git archive` of `main` and, for "today", `--previous
  pnpm@12.10.1` to reproduce production's version resolution. The proposed
  configuration built without it, as a fresh service would.
- Process trees came from `docker top`.
- Signal behavior used a preloaded probe through `NODE_OPTIONS` that logs
  SIGTERM and exit, and `docker stop`, which sends SIGTERM to PID 1 like a
  Railway teardown.

## Sources

- Railway: [start command](https://docs.railway.com/deployments/start-command),
  [deployment teardown](https://docs.railway.com/deployments/deployment-teardown),
  [deploy reference](https://docs.railway.com/deployments/reference),
  [Node.js SIGTERM handling](https://docs.railway.com/deployments/troubleshooting/nodejs-sigterm-handling),
  [serverless](https://docs.railway.com/deployments/serverless),
  [Dockerfiles](https://docs.railway.com/builds/dockerfiles),
  [build configuration](https://docs.railway.com/builds/build-configuration),
  [cost control (replica limits)](https://docs.railway.com/pricing/cost-control).
- Railpack: [Node provider](https://railpack.com/languages/node),
  [configuration file](https://railpack.com/config/file),
  [installing packages](https://railpack.com/guides/installing-packages); source
  at [v0.40.1](https://github.com/railwayapp/railpack/tree/v0.40.1)
  (`core/providers/node/package_manager.go`, `node.go`; `buildkit/convert.go`).
- pnpm: [`pnpm prune`](https://pnpm.io/cli/prune),
  [`pnpm deploy`](https://pnpm.io/cli/deploy),
  [configuration](https://pnpm.io/configuring).
- srvx's graceful-shutdown plugin, as bundled in `apps/admin/.output/server/_libs/`.
- [libwebp releases](https://storage.googleapis.com/downloads.webmproject.org/releases/webp/index.html).
