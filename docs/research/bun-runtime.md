# Bun as the runtime for Control, the Executors, and Admin

Research date: 2026-10-15, at commit `0f40b5eb1b71dca5f52bc2ce80e3809dd63bb3da`.
Runtimes: Bun 1.4.3 and Node 24.21.0, both in the same Linux container.

**Since this was measured:** the efficiency pass that landed with this note
already makes most of the "fix whatever the runtime" items below.

- Every service starts as `node` directly.
- Control drains Executors instead of waking once (ADR 0032).
- Control's Postgres pool has an explicit `max`.
- Control now sends the wake through `node:http` with no header timeout
  (`apps/control/src/executor-dispatch.ts`), so Node's 301-second `fetch`
  limit no longer applies.
- The wake still waits for the job to finish, because the drain needs the
  reply to decide whether to wake again. An immediate `202` would give that
  up.

How `node:http` behaves on Bun for an 11-minute request is unverified, so the
Bun-side caveats about the wake still stand.

The question was whether to move the Node services to Bun, possibly
rewriting them on Bun's native server and S3 client, to cut dependencies and
resource use. This note measures that directly. Every claim was measured for
this note unless it links an upstream source or is marked as inferred. The
edge Worker is out of scope and stays on Cloudflare Workers.

## Answer in brief

- **Bun runs every service unchanged.**
  - Control, both Executors, and Admin built with the default Nitro preset all
    ran on Bun 1.4.3 with no code changes. The full request mix, real video and
    PDF jobs, OTLP log export, and SIGTERM shutdown all worked.
  - All 360 service tests (50 files) pass under `bun --bun vitest`. That run
    includes the testcontainers Postgres tests, with the vitest workers
    themselves running on Bun.
- **Memory falls substantially, but traffic is low, so the money is not.**
  - Control idles at about 78 MB on Bun against 105 MB on Node.
  - After a burst, Node holds its peak (about 300 MB in the benchmark and about
    140 MB in the soak) and does not return it. Bun gives most of it back
    within a minute (about 95 MB and 75 MB respectively).
  - At Railway's $10 per GB-month, the 30 to 60 MB of always-on Control
    memory saved is worth about $0.30 to $0.60 a month.
  - The Executors and Admin sleep, so they are billed only while awake.
- **Process start barely matters at this scale.**
  - An Executor answers its first health check in about 43 ms on Bun.serve
    with Bun's S3 client, against about 88 ms on Node. With the AWS SDK still
    loaded, the Bun figure is 72 ms.
  - Control is about 150 ms on both runtimes.
  - Either way, process start is a small part of a Railway wake, which also
    includes the container start and the private-network hop.
- **Executors use far less memory while awake.** The peak during a job is
  about 70–90 MB on Bun, against 123–151 MB on Node. With Bun's S3 client the
  Bun figure falls to the bottom of that range.
- **Bun removes almost no dependencies by itself.**
  - Running on Bun removes nothing. The savings come only from swapping
    libraries:

    | Swap | Packages removed | Disk saved |
    | --- | --- | --- |
    | AWS SDK | 27 of Control's 69, 26 of each Executor's 29 | 18.2 MB |
    | `pg` | 13 | 0.7 MB |
    | `@hono/node-server` | 1 | 0.2 MB |

  - Railpack keeps Node, because pnpm needs it, and adds Bun. Each image
    therefore grows by about 89 MB (the x64 Bun binary), which outweighs every
    dependency removal combined.
- **Bun's S3 client does not cover what Shutter needs.**
  - `Bun.S3Client` cannot do a conditional delete. It sends no `If-Match`.
  - It does not return the ETag from a put, and it has no batch delete.
  - The Executor's cleanup of a stale or failed attempt
    (`deleteUploadedAttempt`) depends on both: the ETag from the put, then an
    `If-Match` delete. That guard keeps it from deleting a newer attempt's
    master under the same key.
  - The workaround is a presigned URL plus `fetch`. That works against RustFS,
    but it is unverified on R2, and at that point Bun is only signing URLs.
- **Something to fix whatever the runtime decision.** Control waits up to 11
  minutes for an Executor wake, but neither runtime's `fetch` lasts that long
  by default, and `AbortSignal.timeout` does not extend either limit:
  - **Node** gives up after 301 seconds with `UND_ERR_HEADERS_TIMEOUT`. An
    undici `Agent` with `headersTimeout: 0` fixes it.
  - **Bun** gives up at about 360 seconds with `TimeoutError`. Only the
    Bun-specific option `timeout: false` fixes it, because Bun ignores the
    undici `Agent`.

  So the fix is per runtime, and a Node-only fix would silently stop working
  after a move to Bun.

**Recommendation:**

- Do not rewrite anything for Bun now.
- Fix the start commands, the dispatch bug, and the 300-second wake timeout
  first. Those are where the real resource and reliability gains are.
- If you still want Bun after that, pilot it on the PDF Executor using the
  minimal plan under [Migration plan if you go ahead](#migration-plan-if-you-go-ahead):
  an entry-point change to `Bun.serve`, a pinned Bun version, and a
  `bun --bun vitest` CI job. Keep `pg` and `@aws-sdk/client-s3`.
- Keep Control and Admin on Node unless the pilot stays clean for several
  weeks.
- If the services stay on Node, keep `@aws-sdk/client-s3`:
  - It is actively maintained.
  - It costs no more memory on Node than aws4fetch (both about +30 MB in the
    same test).
  - It covers every operation Shutter uses natively. Of the alternatives,
    only aws4fetch can sign all of them, with list and batch delete built by
    hand, and it has not been released since 2024.

## Method

Everything ran on one Apple M5 Pro (18 cores, 48 GB) under Docker Desktop.

**Containers:**

- All containers were linux/arm64 apart from imgproxy, whose only local image
  is amd64 and ran under emulation.
- The image was Debian trixie with Node 24.21.0, Bun 1.4.3, FFmpeg 7.1.5, and
  Poppler 25.03.
- The supporting containers ran on one Docker network:
  - `postgres:17-alpine`, seeded with five Spaces through the one-shot import;
  - `ghcr.io/imgproxy/imgproxy:v4.0.17`, the version `.railway/railway.ts`
    pins;
  - RustFS and MinIO standing in for R2;
  - an HTTPS origin with a private CA, trusted through `NODE_EXTRA_CA_CERTS`
    on both runtimes.

**Where the semantics probes ran:** the probes of `fetch`, crypto,
`child_process`, timers, pinned-lookup HTTPS, long waits, and SIGTERM drain
ran on the macOS host, with Node 24.18.0 and Bun 1.4.3.

**How each service was installed:** with `pnpm deploy --prod`, then copied
into the image so module loading never touched a bind mount.

**How the services were started:** with `node dist/index.js` or
`bun dist/index.js`, never through pnpm. This matches the start-command change
being made in parallel.

**Measurements:**

- RSS is `VmRSS` and `VmHWM` from `/proc/<pid>/status` of the service process
  alone.
- Startup is the time from spawn to the first `200` from `/healthz`, polled
  every 2 ms.
- The harness itself always ran on Node, so it was identical for every
  variant.
- Each variant ran five times in a fresh container, round-robin, so noise was
  spread across variants. Tables show the median with [min–max].

**Noise:**

- Other agents were running tests on the same machine.
- Startup times vary by roughly ±50 ms between runs, so differences smaller
  than that are not real.
- imgproxy emulation dominates optimize latency equally for every variant.

**What production would differ in:** Railway is presumably x86-64 with
different CPUs, and its memory graph is container-level. That includes the
pnpm wrapper today, about 50 MB. The absolute numbers below will not
transfer. The ratios between runtimes are the useful part.

### Control request mix

After boot the harness did the following:

1. Waited 10 s, then measured idle RSS.
2. Ran unloaded latency, one request at a time:
   - 200 edge-config snapshot GETs (`/internal/v1/edge/config`);
   - 200 job-status polls of a pending v2 job;
   - 50 `/internal/v2/optimize` requests, each rendering a 3000×2000 JPEG to
     640 px WebP through imgproxy.
3. Ran a 10-second mixed load at concurrency 16: 55% config, 40% polls,
   5% optimize.
4. Waited 30 s to let memory settle.
5. Sent SIGTERM.

Variants:

| Variant | Command |
| --- | --- |
| `node` | `node dist/index.js` |
| `node-semi1` | `node --max-semi-space-size=1 dist/index.js`, a Node tuning control |
| `bun-node-server` | `bun dist/index.js`, unchanged code with @hono/node-server |
| `bun-native` | a ten-line entry using `Bun.serve({ fetch: app.fetch })` (Appendix A) |
| `bun-native-smol` | the same with `bun --smol` |
| `bun-native-bunsql` | `bun-native` plus `pg` replaced by a shim over `Bun.sql` (Appendix C) |

## Measured results

### Control memory and startup

| Variant | Ready (ms) | Idle RSS | After unloaded run | After load | Settled 30 s later | Peak (HWM) |
| --- | --- | --- | --- | --- | --- | --- |
| node | 149 [129–197] | 105 [103–105] | 138 [134–144] | 302 [298–306] | 301 [298–306] | 301 |
| node-semi1 | 171 [132–210] | 90 [89–90] | 113 [112–114] | 195 [193–197] | 192 [177–197] | 193 |
| bun-node-server | 159 [120–220] | 80 [72–81] | 104 [98–106] | 129 [121–138] | 97 [91–102] | 137 |
| bun-native | 146 [121–214] | 78 [77–81] | 99 [98–100] | 117 [115–123] | 95 [91–96] | 125 |
| bun-native-smol | 149 [115–248] | 77 [77–80] | 100 [97–100] | 119 [113–126] | 92 [83–94] | 126 |
| bun-native-bunsql | 133 [118–240] | 77 [75–78] | 92 | 109 [103–118] | 88 [72–90] | 116 |

All memory columns are MB.

- **Node keeps whatever heap a burst grew.** It did not return any of it in
  the 30-second settle window.
- **Bun returns roughly 55–65% of its growth within that window.**
- **`--max-semi-space-size=1`** is a one-flag change that cuts Node's
  post-burst footprint from 302 to 195 MB. It is a cheap option if the
  services stay on Node.
- **`--smol`** made no material difference.
- **Thread count:** Node runs 11 threads and Bun 32 to 33 (JSC's GC and JIT
  threads plus Bun's I/O pool).

### Control latency, throughput and CPU

| Variant | Config p50 / p99 (ms) | Poll p50 / p99 (ms) | Optimize p50 / p99 (ms) | Load rps | Load p99 (ms) | CPU per request |
| --- | --- | --- | --- | --- | --- | --- |
| node | 0.8 / 6.5 | 0.9 / 4.7 | 25.2 / 34.9 | 1774 [1260–1987] | 46 | 450 µs |
| bun-node-server | 0.6 / 5.1 | 0.9 / 5.0 | 24.6 / 31.6 | 1764 [1447–2836] | 49 | 347 µs |
| bun-native | 0.6 / 2.7 | 0.9 / 4.8 | 25.1 / 45.8 | 1951 [1466–2435] | 47 | 308 µs |
| bun-native-bunsql | 0.6 / 5.2 | 0.7 / 16.9 | 24.3 / 144 | 1385 [997–1772] | 81 | 261 µs |

- **Unloaded latency is the same on both runtimes.** It is dominated by
  Postgres and by imgproxy.
- **Throughput is bound by Postgres and the emulated imgproxy, and is within
  noise.**
- **Bun uses 25–30% less CPU per request.** CPU is about zero in production,
  so this saves nothing in practice.
- **Bun does a little more CPU work after a burst.** It spends 60–110 ms per
  30 s while returning memory, against Node's 10 ms, i.e. under 0.4% of one
  core for about a minute.
- **The Bun.sql shim had worse tail latency.** Poll p99 was 17 ms against
  5 ms, and the load p99 rose from 47 to 81 ms. It saved only about 7 MB.

### Control soak at low traffic

Three Controls ran side by side: Node, Bun with node-server, and Bun.serve.

- **Traffic:** one mixed request every 5 s, plus a burst of 1,500 requests at
  concurrency 8 every 15 minutes.
- **Duration:** the sampler covered 41 minutes and two bursts. The host then
  suspended, which ended the run.
- **Late sample:** one more RSS reading was taken a few minutes after the host
  resumed.

| Time | Node RSS | Bun (node-server) RSS | Bun.serve RSS |
| --- | --- | --- | --- |
| 5 min, steady trickle | 82 | 73 | 71 |
| 14.6 min, before burst 1 | 83 | 73 | 67 |
| 15.1 min, right after burst 1 | 141 | 98 | 92 |
| 16 min | 141 | 82 | 77 |
| 29 min, before burst 2 | 136 | 78 | 72 |
| 30.3 min, right after burst 2 | 142 | 101 | 93 |
| Late sample | 125 | 67 | 61 |

All values are MB. Neither runtime showed upward drift across the two
bursts.

Node's resting RSS under a trickle (about 82 MB) is lower than its 10-second
post-boot reading (105 MB), because V8's memory reducer shrinks the heap once
the process goes idle. Its first burst then raised it by about 60 MB, and that
stayed. The production figures (average 152 MB, maximum 235 MB, including
about 50 MB of pnpm) are consistent with this.

A 41-minute soak cannot rule out slow leaks. The open Bun memory issues are
listed under [risks](#risks-that-would-come-with-bun).

### Executors

Each run used a fresh container holding an Executor variant on port 3000:

1. The harness measured cold start to `/healthz`.
2. After 5 s it took an idle RSS reading.
3. It submitted two v2 jobs to a separate Node Control.
4. Control woke the Executor over the private URL, exactly as in production.

Each job ran the real pipeline:

1. claim;
2. HTTPS download from the origin, either a 16 MB 1080p H.264 file or a
   one-page PDF;
3. ffmpeg / ffprobe, or pdfinfo / pdftoppm / ffmpeg / ffprobe;
4. PutObject to RustFS;
5. complete.

All 80 jobs finished `ready`, and every process exited 0 on SIGTERM.

Variants:

| Variant | Command |
| --- | --- |
| node | `node dist/index.js` |
| bun-node-server | `bun dist/index.js`, unchanged |
| bun-native | Appendix B's `Bun.serve` entry |
| bun-native-bun-s3 | the same, plus the AWS SDK replaced by Bun.S3Client presign + `fetch` (Appendix B) |

| Variant | Ready (ms) | Idle RSS | Peak RSS after 2 jobs | Settled 20 s later | First job end to end (ms) | Second job (ms) | Parent CPU per job |
| --- | --- | --- | --- | --- | --- | --- | --- |
| video / node | 88 [84–106] | 88 [87–90] | 151 [150–152] | 151 [150–152] | 338 [313–2044] | 237 | 105 ms |
| video / bun-node-server | 82 [79–161] | 62 [62–63] | 90 [87–91] | 75 [74–76] | 327 | 229 | 45 ms |
| video / bun-native | 71 [67–84] | 60 [59–60] | 87 [85–87] | 74 [74–74] | 323 | 236 | 45 ms |
| video / bun-native-bun-s3 | 45 [38–47] | 50 [49–51] | 72 [71–75] | 62 [62–63] | 281 | 223 | 40 ms |
| pdf / node | 89 [82–111] | 90 [88–91] | 123 [122–125] | 108 [107–109] | 395 | 291 | 40 ms |
| pdf / bun-node-server | 84 [80–85] | 62 [62–62] | 89 [87–89] | 73 [72–73] | 379 | 292 | 15 ms |
| pdf / bun-native | 73 [69–85] | 60 [60–61] | 88 [86–89] | 72 [71–72] | 388 | 330 | 25 ms |
| pdf / bun-native-bun-s3 | 42 [40–55] | 51 [49–51] | 70 [69–70] | 58 [58–59] | 393 | 293 | 15 ms |

Memory columns are MB. "Peak RSS" is the parent process's `VmHWM`, read at
the end of the run.

- **Job duration is the same on both runtimes.** It is bound by the media
  tools and the transfers, which do not run in JavaScript.
- **The peak covers the parent process only.** FFmpeg and Poppler run as
  separate processes, so a container's peak during a large job is higher on
  either runtime. These fixtures are small: a larger video or a dense PDF
  raises the child processes' memory, not the parent's.
- **Bun saves 30–80 MB per awake Executor,** depending on the phase and on
  whether the SDK is still loaded. Node does not return its job-time growth.
- **The Executor cold start gains little from Bun alone.** It is about 17 ms
  faster with the SDK still loaded, and about 43 ms faster without it. Most of
  that saving comes from no longer loading the AWS SDK's module graph.

### Admin

Admin was built twice:

- with the default Nitro preset (`node-server`);
- with `NITRO_PRESET=bun`, which serves through `Bun.serve`.

Both outputs are self-contained 2.3 MB bundles.

Each run did the following:

1. Waited for `/login` to answer `200`.
2. Waited 10 s, then measured idle RSS.
3. Signed in through `POST /api/auth/login`.
4. Requested `/login` 100 times.
5. Requested the overview `/` 100 times. That is an SSR page of about 15 KB
   that calls Control's `/v1/admin/overview`.
6. Settled for 30 s.

| Variant | Ready (ms) | Idle RSS | After 200 requests | Settled | Overview p50 / p99 (ms) | SIGTERM to exit |
| --- | --- | --- | --- | --- | --- | --- |
| node, node preset | 70 [65–72] | 67 [67–68] | 127 [122–131] | 107 [99–129] | 1.6 / 20.9 | 1.02 s |
| bun, node preset | 82 [80–91] | 58 [57–59] | 116 [113–120] | 81 [80–82] | 1.5 / 12.8 | 1.02 s |
| bun, bun preset | 68 [66–72] | 57 [56–58] | 113 [112–114] | 75 [75–76] | 1.4 / 12.2 | 1.01 s |

Memory columns are MB.

Sign-in, the session cookie, server functions, and the SSR call to Control
all worked on Bun, with both presets.

### S3 client cost

The test did 20 rounds of the Executor's two operations against RustFS:

1. A 200 KB PutObject, reading the ETag back.
2. A conditional DeleteObject with a wrong ETag, which must fail with `412`.
3. A conditional DeleteObject with the right ETag.

RSS was read at the end of a fresh process, five runs each.

| Runtime / client | RSS after | Growth over the empty script | ms per round | Wrong `If-Match` |
| --- | --- | --- | --- | --- |
| node, nothing | 59.6 | – | – | – |
| node, @aws-sdk/client-s3 | 89.0 | +29.4 | 5.3 | 412 |
| node, aws4fetch | 91.8 | +32.2 | 3.3 | 412 |
| bun, nothing | 20.4 | – | – | – |
| bun, @aws-sdk/client-s3 | 79.1 | +59.4 | 7.0 | 412 |
| bun, aws4fetch | 35.9 | +16.2 | 2.2 | 412 |
| bun, Bun.S3Client presign + fetch | 24.7 | +5.0 | 2.0 | 412 |

RSS and growth are in MB.

- **On Node,** replacing the SDK with aws4fetch saves no memory. The growth is
  V8 heap and undici, not SDK code.
- **On Bun,** the SDK is the single most expensive dependency, at about 55 MB
  more than Bun's own client.

### Images and dependencies

**Binaries:**

- **Node 24.22.0 x64:** 127 MB. The arm64 binary measured in the test image is
  123 MB.
- **Bun 1.4.3:** 89 MB, for both linux-x64 and aarch64.

**Packages each swap would remove:** these come from
`pnpm list --prod --depth Infinity` and count one copy of each package.

| Service | Production closure | Without AWS SDK | Without `pg` | Without node-server | Without all three |
| --- | --- | --- | --- | --- | --- |
| Control | 69 packages, 76.9 MB | −27, −18.2 MB | −13, −0.7 MB | −1, −0.2 MB | −41, −19.2 MB |
| Each Executor | 29 packages, 29.3 MB | −26, −18.2 MB | n/a | −1, −0.2 MB | −27, −18.4 MB |

- **What is left in Control after all three swaps:** the largest remaining
  pieces are not candidates for removal:
  - drizzle-orm, 16.5 MB, used only for migrations;
  - OpenTelemetry, 27.8 MB across 11 packages;
  - zod, 8 MB;
  - hono, 2.8 MB.
- **What the image actually holds:** Railpack installs the whole workspace.
  Locally that is 828 MB of `node_modules`, mostly development tooling such as
  wrangler, workerd, vite, and TypeScript. The AWS SDK is about 2% of it.
- **What Bun adds:** Railpack still installs Node for pnpm, so Bun is an extra
  89 MB on top.
- **Admin:** its runtime is a self-contained 2.3 MB Nitro bundle, so the
  runtime choice changes nothing in its dependencies.

## Compatibility audit

Each row below was run on both runtimes unless it says otherwise.

| Area | Shutter usage | Result on Bun 1.4.3 |
| --- | --- | --- |
| `pg` + drizzle | Raw `pool.query` / `client.query` with `$n` parameters, repeatable-read transactions, `pg_advisory_xact_lock`, session `pg_advisory_lock`; drizzle only for the schema and migrations | Works unchanged, including migrations and the whole Postgres test suite under `bun --bun vitest` |
| `Bun.sql` instead of `pg` | (prototype) | Two type mismatches with `pg`, both fixed in the shim (Appendix C); results above. Moving to `Bun.sql` means rewriting the data layer and testing it on Bun |
| drizzle `bun-sql` driver | Not needed: Control does not query through drizzle | Docs install `drizzle-orm@rc`; open issues include unserialized JSON values ([#6132](https://github.com/drizzle-team/drizzle-orm/issues/6132)) |
| pino | `pino({ base }, stdout)`, no transports | Works; JSON lines are identical. Transports and worker threads are not used; they hang on exit under Bun ([oven-sh/bun#32157](https://github.com/oven-sh/bun/issues/32157)), and pino supports only Node ([pino#1842](https://github.com/pinojs/pino/issues/1842)) |
| OpenTelemetry | `sdk-logs` `BatchLogRecordProcessor` + `exporter-logs-otlp-http` (JSON) | Works. Batches export, headers and resource attributes are correct, and the final batch flushes on SIGTERM on Node, Bun with node-server, and Bun.serve alike |
| OTel auto-instrumentation | Not used | Broken on Bun: channels are garbage-collected ([#26536](https://github.com/oven-sh/bun/issues/26536)) and there are no ESM loader hooks ([#11905](https://github.com/oven-sh/bun/issues/11905)). Upstream OTel does not support Bun |
| @aws-sdk/client-s3 | Put, conditional delete, list, batch delete, presign | Works, including signed `If-Match`. Costs about 55 MB more on Bun than Bun's own client |
| @hono/node-server | Every service | Works on Bun, including a 330-second handler and graceful close |
| node-server's `serve()` | – | Replaces the global `Response` with a lightweight class. A `Bun.serve` in the same process then answers "Welcome to Bun!" to every Hono response, with a duplicated `Content-Length` that Node's fetch rejects. Use one server per process; importing the package alone is harmless |
| `node:crypto` | `timingSafeEqual`, `createHash`, `createHmac`, AES-256-GCM, `randomBytes`, `randomUUID`; Web Crypto in protocol | Identical outputs and error codes (`ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`) |
| `child_process.spawn` | ffmpeg, ffprobe, pdftoppm, pdfinfo with piped stdio, SIGKILL on timeout, `close` code | Identical: exit 0, exit 254 with stderr, `signal: "SIGKILL"` with `code: null`, and ENOENT for a missing binary. Real video and PDF jobs complete |
| `fetch` `redirect: "manual"` / `"error"` | Executor source download / imgproxy delegation | `manual` returns the 302 and `Location`, but `response.type` is `"default"` instead of `"basic"`; Shutter never reads it. `error` rejects with `TypeError` on both |
| `fetch` streaming + `Readable.fromWeb` + Transform limit | `downloadSource` | Identical, including the byte limit tripping mid-stream |
| `fetch` `AbortSignal.timeout`, Range | Downloads, wakes, admin probe | Identical |
| Long waits (Executor wake, 11 min budget) | `sendExecutorWake` | No bytes before the answer, with `AbortSignal.timeout(11 min)`. Answered after 330 s: Node fails at 301 s (`UND_ERR_HEADERS_TIMEOUT`); Bun succeeds. Answered after 620 s: Node fails at 301 s; Bun fails at 360 s (`TimeoutError`) unless `timeout: false` is passed, in which case it succeeds at 620 s. Node with `Agent({ headersTimeout: 0 })` also succeeds at 620 s |
| undici `Agent` / `dispatcher` | Possibly added by parallel work for wakes and keep-alive | Ignored by Bun: `import "undici"` resolves to Bun's shim and `dispatcher` has no effect ([#38840](https://github.com/oven-sh/bun/issues/38840), [#17799](https://github.com/oven-sh/bun/issues/17799)). An `Agent` with `headersTimeout: 0` fixed the 620 s wait on Node but still failed at 360 s on Bun. A Node-only fix for long wakes therefore breaks silently after a move to Bun |
| `node:https` with a pinned `lookup` | Admin resolver test SSRF guard | Honoured on Bun. TLS still verifies the hostname (`ERR_TLS_CERT_ALTNAME_INVALID` on a mismatch). `NODE_EXTRA_CA_CERTS` works |
| `node:dns` `lookup({ all: true })`, `node:net` `isIP` | SSRF guard | Identical |
| Timers `unref` | Recovery sweep, shutdown budgets | Identical (`unref()` returns the timer; `hasRef()` is false) |
| SIGTERM | Control drains HTTP, closes the pool, flushes OTLP | Exit code 0 everywhere, and an in-flight 3-second request completes while new connections are refused. node-server's `close()` waits out the client's keep-alive, about 5 s after the last response, on both runtimes. `Bun.serve().stop()` resolves as soon as the in-flight request ends |
| `Bun.serve` idle timeout | Executor `run-once` holds the response for the whole job | Default 10 s: an empty reply after 12 s. `idleTimeout: 255` (the maximum) cut the connection at 256 s. `idleTimeout: 0` or `server.timeout(req, 0)` held it for 330 s |
| `console.info(object)` | Executor operational events | Both print multi-line, non-JSON objects. Node uses single quotes; Bun uses double quotes and trailing commas. Any log-search pattern written against one won't match the other |
| TypeScript | `tsc -p` with `types: ["node"]` | Adding `bun-types` 1.4.3 next to `@types/node` typechecks Control plus a `Bun.serve` and `Bun.S3Client` file cleanly with TypeScript 7.0.2. The Worker's tsconfig must never get these types |
| Tests | vitest 5 + testcontainers | `bun --bun vitest run --project services`: 360 of 360 pass in 3.0 s, against 5.1 s on Node, with workers confirmed on Bun 1.4.3. `bun test` (Bun's own runner) passes 11 of 13 Executor tests; the two failures are `vi.waitFor`, which Bun's vitest shim lacks |

## Bun-native replacements

### Bun.serve vs @hono/node-server

Hono works on `Bun.serve` without an adapter (`fetch: app.fetch`), so the
switch is one entry file per service (Appendix A). It saves 2–12 MB of RSS
over node-server on Bun (idle and after load), plus one package. It also
drains on SIGTERM without waiting out keep-alives.

It brings three obligations:

1. **Set the idle timeout.** The 10-second default would break the Executor
   wake, and the 255-second maximum is shorter than a 10-minute job. Call
   `server.timeout(req, 0)` on `run-once`; for Control, `idleTimeout` must
   exceed imgproxy's 45-second timeout.
2. **Never call node-server's `serve()` in the same process.**
3. **Typecheck the entry with `bun-types`.**

An open issue reports `node:http` servers on Bun, node-server included,
stuck at 100% CPU after hours of uptime
([#32600](https://github.com/oven-sh/bun/issues/32600)). That alone argues
for `Bun.serve` over node-server if a service moves to Bun.

### Bun.sql vs pg

The 13 packages and 0.7 MB `pg` brings are not worth a data-layer rewrite.

The shim needed two `pg`-compatibility fixes:

- **Array parameters.** `pg` sends a JS array as a Postgres array literal.
  `Bun.sql`'s `unsafe(text, params)` mis-encodes `$1::integer[]` and the
  server answers "insufficient data left in message".
- **Array columns.** `Bun.sql` returns `int4[]` columns as an `Int32Array`.
  Control's zod parsing then fails with "Attempting to store non-configurable
  property on a typed array".

Session advisory locks need `sql.reserve()`. That worked, but tail latency
got worse. There are also open `Bun.sql` correctness issues, for example
`transaction.close({ timeout })` committing instead of rolling back
([#32148](https://github.com/oven-sh/bun/issues/32148)).

Above all, the existing Node test suite cannot exercise `Bun.sql` at all.
Keep `pg`, which works on Bun unchanged.

### Bun.S3Client vs @aws-sdk/client-s3 (and aws4fetch)

These are every S3 operation in the repository, run against RustFS, which
honours `If-Match` on DeleteObject. MinIO ignores it and deleted on a wrong
ETag even through the SDK, so MinIO cannot validate this guard.

| Operation (where) | AWS SDK | Bun.S3Client | aws4fetch |
| --- | --- | --- | --- |
| PutObject with `ContentType`, read the ETag (Executor) | ✓ `ETag` | `write()` returns the byte count only. Workaround: `presign({ method: "PUT", type })` plus `fetch`, then read the `etag` header; verified | ✓ response header |
| DeleteObject with `IfMatch` (Executor stale attempt) | ✓ `if-match` is signed | `delete()` sends no `If-Match` and ignores any option. Workaround: `presign({ method: "DELETE" })` plus `fetch` with an unsigned `If-Match`; `412` on a wrong ETag against RustFS; **unverified on R2** | ✓ signed |
| ListObjectsV2 by prefix with continuation (purge) | ✓ | ✓ `list({ prefix, continuationToken })` (since 1.2.9); verified paginating 5 keys at `maxKeys: 2` | sign the GET; parse the XML yourself |
| DeleteObjects batch (purge) | ✓ | ✗; one `delete()` per key | sign the `POST ?delete` XML yourself |
| Presigned GET, 60 s / 600 s, path-style (master store, resolvers) | ✓ | ✓ `presign(key, { expiresIn })`, path-style by default | ✓ `signQuery` |
| Endpoint + region `auto` for R2 | ✓ | ✓ `endpoint`, `region` options | ✓ |
| Per-resolver credentials (Control keeps one client per key) | ✓ | ✓ one client per credential | ✓ |

Upstream, conditional writes, conditional deletes, and an ETag from `write()`
have been requested since 2025-02 and are still open
([#17339](https://github.com/oven-sh/bun/issues/17339)).

With the workarounds, Bun's client is reduced to a SigV4 presigner in front of
`fetch`, which is what aws4fetch is. aws4fetch:

- signs every request Shutter needs, including the `If-Match` delete, though
  list and batch delete need hand-built XML;
- is one 65 KB package with no dependencies;
- runs on both runtimes;
- has not been released since 1.0.20 (2024-08-28).

s3mini 1.0.2 (2026-09-15) is maintained and has no dependencies, but it does
not fit:

- its `deleteObject` takes no conditional option;
- it can presign only GET and PUT;
- on Bun, it delegates deletes to `Bun.S3Client`.

## Risks that would come with Bun

- **Two runtimes.**
  - Dev (`tsx`) and today's CI run Node. The CLI already uses Bun, but only
    to compile.
  - Production on Bun means the production runtime is tested only if CI also
    runs `bun --bun vitest`. That suite passes today, but nothing keeps it
    passing.
  - The admin dev server (vite) and the Worker toolchain stay on Node either
    way.
- **Runtime-specific HTTP client behaviour.**
  - Bun's `fetch` has its own default limit (about 360 s with no bytes) and
    ignores undici dispatchers.
  - Any timeout or keep-alive tuning written for Node does nothing on Bun,
    and the reverse is also true.
- **The edge is unaffected,** as long as Bun types and Bun-only modules stay
  out of `apps/edge` and `packages/protocol`. `scripts/check-edge-boundary.mjs`
  already guards Node imports; a `Bun.` global would need the same treatment.
- **Open Bun issues relevant to long-running servers:**
  - `node:http` 100% CPU after hours ([#32600](https://github.com/oven-sh/bun/issues/32600));
  - heap caps (`--max-old-space-size`, `BUN_JSC_*`) are accepted but not
    enforced ([#34917](https://github.com/oven-sh/bun/issues/34917));
  - memory growth with many `fetch` calls ([#20912](https://github.com/oven-sh/bun/issues/20912));
  - a reused keep-alive POST failing with ECONNRESET when the server closes
    idle sockets (opened 2026-10-13, [#45138](https://github.com/oven-sh/bun/issues/45138)).
    Control's imgproxy and Executor calls are exactly that pattern.
- **Observability.**
  - The logs-only OTLP setup works.
  - Any future tracing through OTel auto-instrumentation will not work on
    Bun.
  - The Executor log format changes slightly.
- **Debugging and profiling.**
  - `--inspect` speaks the WebKit Inspector protocol (debug.bun.sh) instead of
    Chrome DevTools.
  - `--cpu-prof` (since 1.3.2) and `--heap-prof` V8-format heap snapshots
    (since 1.3.7) exist.
  - Node's familiar tooling (clinic, `--heapsnapshot-signal`) does not apply.
- **Railpack.**
  - Railpack installs Bun only when the root `package.json` scripts or the
    deploy start command match `bun `.
  - It always keeps Node for pnpm, so images grow by about 89 MB.
  - Without a pin, the Bun version defaults to `latest`. Pin it with
    `RAILPACK_BUN_VERSION`, `engines.bun`, or `.bun-version`.
  - Whether a Railway start command set through IaC counts as Railpack's start
    command is not documented. Using `RAILPACK_PACKAGES` or a root script
    avoids depending on it.
  - Sources: [railpack node provider](https://github.com/railwayapp/railpack/blob/main/core/providers/node/node.go),
    [railpack Bun](https://railpack.com/languages/bun).
- **pnpm stays the package manager.** Bun as only the runtime needs no
  lockfile change; `bun dist/index.js` resolves pnpm's symlinked
  `node_modules`, as every run here did.
- **TanStack Start (Admin).**
  - Both builds run on Bun: Nitro's default `node-server` output, and the
    `bun` preset (`NITRO_PRESET=bun`, which serves through `Bun.serve`).
  - Open Nitro issues on the bun preset: raw request body proxying
    ([nitro#4604](https://github.com/nitrojs/nitro/issues/4604)), SSE
    ([nitro#3677](https://github.com/nitrojs/nitro/issues/3677)), and
    `createFileRoute` API endpoints ([nitro#3808](https://github.com/nitrojs/nitro/issues/3808)).
  - Admin's login is a `createFileRoute` server handler that read form data
    correctly in this test.

## Recommendation per service

**Shared context:**

- Production CPU is about zero, and memory is billed at $10 per GB-month.
- Control is the only always-on service.
- The Executors and Admin sleep, so their memory costs money only while they
  are awake.
- After the start-command fix, Control loses the pnpm wrapper (about 50 MB),
  which on its own is a bigger saving than switching runtimes.

### Control: stay on Node for now

- **Expected saving on Bun:**
  - idle drops from about 82–105 MB to about 70–80 MB;
  - after a burst, about 140 MB drops to 75 MB, and 300 MB to 95 MB;
  - roughly 30–60 MB of average resident memory, worth $0.30–0.60 a month.
- **Risks:**
  - Control is the always-on service that holds the Postgres pool, the
    imgproxy keep-alive, and the 11-minute Executor wakes. That is precisely
    where the open `node:http` CPU and keep-alive ECONNRESET issues bite.
- **Cheaper Node levers:**
  - `--max-semi-space-size=1` is measured here: idle 105 → 90 MB and
    post-burst 300 → 195 MB.
  - An explicit `pg.Pool` `max` is inferred, not measured.
- **Fix in any case:** the 300-second wake timeout. Either:
  - add an undici `Agent` with `headersTimeout: 0` (and a `bodyTimeout` above
    the job limit) to the wake `fetch` on Node, plus `timeout: false` on Bun;
  - or, better because it is runtime-neutral, stop holding the wake open for
    the whole job. Answer `202` at once and let the Executor's existing
    complete/fail calls report the outcome.

### Executors: best candidate, optional pilot

- **Expected saving:**
  - awake RSS falls from 88–90 MB idle and 123–151 MB peak to 60–62 and
    87–90 MB, unchanged code with the SDK still loaded;
  - with Bun's S3 client as well, to 50 MB idle and 70–72 MB peak;
  - process start drops from about 88 ms to about 43 ms, but only with the
    SDK gone.
- **Why it is worth so little:** after the dispatch fix they will be asleep
  almost all the time, so the saving is real per wake but tiny per month. Most
  of a cold start is Railway's container wake, not the process.
- **Risks:**
  - the `Bun.serve` idle timeout (handled in Appendix B);
  - an S3 swap that cannot be verified against R2 locally;
  - a slight change in log format.
- **Recommendation:** do it only if awake memory or cold start still matters
  after the dispatch fix.
  - Keep the AWS SDK for the first step. Bun with the SDK already gives most
    of the memory saving: 60 against 88 MB idle, and 87–90 against
    123–151 MB peak.
  - Swap S3 later, and only after checking presigned `DELETE` with `If-Match`
    against a staging R2 bucket. The startup gain needs the SDK gone.

### Admin: stay on Node

- **On Bun:** about 10 MB less idle and about 30 MB less after use. The Nitro
  bun preset adds only another 6 MB over Bun running the node preset.
- It sleeps when idle, so a 20 to 30 MB difference while an operator is
  using it is worth nothing.
- The Nitro bun preset carries open issues.
- Admin is also the service whose build tooling (vite) must stay on Node.

### S3 client if everything stays on Node

Keep `@aws-sdk/client-s3`:

- It was released 2026-10-14 and is maintained by AWS.
- It covers every operation Shutter uses, including list, batch delete, and
  presign, without hand-built requests. aws4fetch signs a correct `If-Match`
  delete too, but leaves list and batch delete to be built and parsed by hand.
- On Node, its memory cost is the same as aws4fetch's (+29 vs +32 MB).
- Its 26 packages and 18 MB are about 2% of what Railpack installs anyway.

If the dependency count itself is the goal, aws4fetch is the only lighter
option that fits all of Shutter's operations. It is small enough to vendor
(one file). Its age matters less than it sounds, because SigV4 is a frozen
algorithm, but nobody is maintaining it.

Neither s3mini nor `Bun.S3Client` covers conditional delete.

## Migration plan if you go ahead

This is the minimal path, PDF Executor first. Each step is independently
revertible. No step changes the protocol, the edge, or the tests'
expectations.

1. **CI.** Add a job that runs
   `bun --bun node_modules/vitest/vitest.mjs run --config vitest.node.config.ts --project services`
   with Bun pinned to 1.4.3, next to the Node job. Both must pass. Keep vitest
   and testcontainers; do not move to `bun test`.
2. **Types.** Add `bun-types` (or `@types/bun`), pinned to the runtime
   version, to `packages/executor-runtime` only, in its tsconfig `types`.
   Never add it to `apps/edge` or `packages/protocol`.
3. **Server.** In `packages/executor-runtime`, make `serveExecutorApp` choose
   `Bun.serve` when `globalThis.Bun` exists, as in Appendix B. That means
   `server.timeout(request, 0)` on `/internal/v1/run-once` and `server.stop()`
   on SIGTERM. Keep `@hono/node-server` for Node; it is only imported, not
   called, on Bun, which is safe.
4. **Railway.** In `.railway/railway.ts`, for `Shutter-Executor-PDF` only:
   - set the start command to `bun apps/executor-pdf/dist/index.js`;
   - add `RAILPACK_BUN_VERSION=1.4.3` (or `RAILPACK_PACKAGES=bun@1.4.3`) so
     Railpack installs a pinned Bun next to Node.

   Update the configuration test that guards the Railway graph.
5. **Observe** for two weeks:
   - wake failures in Control (`control.dispatch.failed`);
   - job duration;
   - Railway memory and CPU while awake;
   - any CPU that stays high after a wake.

   Then repeat steps 4–5 for the video Executor.
6. **S3, optional.** Behind the existing `MediaStoreClient` seam (`send`
   with Put/Delete), add a Bun implementation that presigns with
   `Bun.S3Client` and calls `fetch` (Appendix B). Do this only after:
   - a staging R2 bucket answers `412` to a presigned DELETE with a stale
     `If-Match`;
   - the put's `ETag` header matches what Control stores.

   Then drop `@aws-sdk/client-s3` from executor-runtime's dependencies. It
   stays in Control for presigning and purge unless Control moves too.
7. **Control, only after the Executors have run clean for several weeks.**
   - Use a `Bun.serve` entry (Appendix A) with `idleTimeout` above 45 s.
   - Keep `pg`, the AWS SDK, pino, and OTel.
   - Make the wake survive on Bun: pass `timeout: false` (an undici `Agent`
     has no effect there), or use the runtime-neutral immediate-`202` wake.
   - Verify the 11-minute wake on Bun with a slow staging job before cutting
     over.

## What was not measured, and why

- **Production or Railway itself.** Out of bounds for this task. All numbers
  are local Linux arm64 under Docker Desktop, not Railway x86-64. Container
  start, image pull, and private-network wake latency on Railway were not
  measured, so the share of a real Executor cold start that the process
  accounts for is inferred.
- **R2.** No staging bucket was available. RustFS stood in for conditional
  deletes; R2's handling of an unsigned `If-Match` on a presigned DELETE is
  unverified.
- **Long-term stability.** The soak covered 41 minutes, not days, and the
  host suspended once. The open upstream issues above are not reproduced
  here.
- **Railpack image builds.** Image growth is computed from binary sizes
  (Bun 89 MB) rather than from building the Railpack image.
- **The PDF Executor on the host.** Poppler is not installed on this machine,
  so PDF jobs ran only inside the container, which has Poppler 25.03.

## Appendix A: Control on Bun.serve

The prototype entry is equivalent to `apps/control/src/index.ts` with the
server swapped:

```ts
const server = Bun.serve({ fetch: app.fetch, port: env.PORT, idleTimeout: 120 });
// ...
const shutdown = createControlShutdown({
  // ...
  closeServer: () => server.stop(false), // resolves when in-flight requests finish
});
```

## Appendix B: Executor on Bun.serve, and the S3 seam

```ts
const server = Bun.serve({
  port,
  fetch(request, server) {
    // run-once holds its response for the whole job; Bun.serve would otherwise
    // close a silent connection after idleTimeout (default 10 s, max 255 s).
    if (new URL(request.url).pathname === "/internal/v1/run-once") server.timeout(request, 0);
    return app.fetch(request);
  },
});
process.once("SIGTERM", () => void server.stop());
```

The S3 operations through `Bun.S3Client`, which signs, and `fetch`, which
carries the conditions:

```ts
const s3 = new Bun.S3Client({ endpoint, region, accessKeyId, secretAccessKey });
// PutObject with the ETag
const put = await fetch(s3.presign(key, { bucket, method: "PUT", expiresIn: 300, type: "image/webp" }),
  { method: "PUT", body: bytes, headers: { "content-type": "image/webp" } });
const etag = put.headers.get("etag");
// DeleteObject only if the object is still ours
const del = await fetch(s3.presign(key, { bucket, method: "DELETE", expiresIn: 300 }),
  { method: "DELETE", headers: { "if-match": etag } }); // 412 when a newer object owns the key
```

## Appendix C: Bun.sql shim

The prototype replaced the `pg` module through a Bun preload plugin
(`build.module("pg", …)`) with a `Pool` whose `query(text, params)` calls
`sql.unsafe(text, params)` and whose `connect()` returns `sql.reserve()`.
Results were adapted to `{ rows, rowCount }`. The two fixes described above
were needed: array parameters were sent as Postgres array literals, and typed
array columns were converted to plain arrays. It is evidence of the work
involved, not a proposal.
