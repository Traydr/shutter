# Go Render Service Prototype Results

Benchmark date: 2026-07-13. Environment: linux/amd64, Go 1.22.2, Node v22.14.0.

Fixtures: `sample-10page.pdf`, `sample-1080p-30s.mp4`, `sample-720p-10s.mp4`.
Node baseline from `../results/baseline.json` (3 iterations, same fixtures).

## Architecture overview

Three prototype services live under `experiments/executor-perf/go-services/`:

### Option A — `subprocess-svc` (thin Go wrapper)

Mirrors the production Node.js pipelines exactly:

| Kind | Pipeline |
|------|----------|
| PDF | `pdfinfo` → `pdftoppm` → `ffmpeg` → `ffprobe` |
| Video | `ffmpeg -ss 1` (fallback without seek) → `ffprobe` |

Go replaces Node's `child_process.spawn` orchestration. The heavy work still runs in the same external binaries. This isolates how much overhead Node adds on top of subprocess cost.

### Option C — `combined-svc` (optimized combined render service)

Single always-on service for PDF and video with pipeline optimizations:

| Kind | Changes vs baseline |
|------|---------------------|
| PDF | Drops `ffprobe`; reads PNG dimensions via `image.DecodeConfig`, computes scaled size in-process |
| Video | Drops `ffprobe`; reads WebP dimensions via `image.DecodeConfig`; keeps `-ss 1` input seek |

Same external tools, fewer subprocess invocations per job.

### Option B — `fitz-svc` (MuPDF library binding)

| Kind | Pipeline |
|------|----------|
| PDF | `go-fitz` (MuPDF) renders page 1 at 150 DPI → in-process WebP encode via `chai2010/webp` |
| Video | Reuses combined video pipeline (ffmpeg still required; no practical pure-Go decoder) |

Requires CGO + `libmupdf-dev` at build time. Eliminates `pdftoppm`, intermediate PNG, and `ffmpeg` for typical PDFs under 1920px wide.

## Benchmark results (median wall-clock ms)

### PDF (`sample-10page.pdf`)

| Approach | CLI median | HTTP median | vs Node baseline (243 ms) |
|----------|-----------|-------------|---------------------------|
| Node baseline (`pdf-baseline-pdftoppm-ffmpeg`) | — | — | — |
| Go subprocess (Option A) | 242 | 239 | **~0%** (parity) |
| Go combined (Option C) | 212 | 209 | **−13%** |
| Go fitz (Option B) | 110 | 104 | **−55%** |

Step breakdown (Go subprocess, last run): pdfinfo 6 ms, pdftoppm 67 ms, ffmpeg 134 ms, ffprobe 35 ms.
Step breakdown (Go fitz, last run): fitz_render 24 ms, webp_encode 91 ms.

**Takeaway:** Go orchestration alone does not beat Node for the same subprocess chain. Skipping `ffprobe` saves ~35 ms. MuPDF in-process rendering saves ~130 ms by removing `pdftoppm` + `ffmpeg` for this fixture.

### Video 1080p/30s

| Approach | CLI median | HTTP median | vs Node baseline (222 ms) |
|----------|-----------|-------------|---------------------------|
| Node baseline (`video-baseline-ss1-fallback`) | — | — | — |
| Go subprocess (Option A) | 239 | 235 | **+8%** (noise) |
| Go combined (Option C) | 206 | 193 | **−13%** |
| Go fitz video (same as combined) | 189 | 200 | **−15%** |

ffmpeg dominates (~190–210 ms). Dropping `ffprobe` saves ~36 ms. Go vs Node spawn overhead is negligible compared to ffmpeg decode time.

### Video 720p/10s

| Approach | CLI median | vs Node baseline (144 ms) |
|----------|-----------|---------------------------|
| Go subprocess | 141 | ~0% |
| Go combined | 108 | **−25%** |
| Go fitz video | 114 | **−21%** |

### HTTP overhead

Comparing CLI vs HTTP medians on the same warm service: **< 5 ms** per request. Always-on deployment adds negligible per-job latency once the service is running.

## Binary size, memory, cold start

| Binary | Size | Idle RSS (HTTP service) | Peak RSS (single CLI render) |
|--------|------|-------------------------|------------------------------|
| `render-cli` | 12.5 MB | — | — |
| `subprocess-svc` | 16.4 MB | ~10 MB | ~5.7 MB (+ child processes) |
| `combined-svc` | 16.4 MB | ~10 MB | ~5.7 MB (+ child processes) |
| `fitz-svc` | 16.7 MB | ~77 MB | ~34 MB |

Cold start (CLI process spawn → render → exit, PDF):

| Approach | Wall time |
|----------|-----------|
| subprocess | 253 ms |
| combined | 213 ms |
| fitz | 114 ms |

**Cold start implications:**

- **Serverless executors** (`sleepApplication: true`): every wake pays Node + subprocess startup. A Go always-on sidecar avoids per-job process cold start for the render path, but the executor itself still sleeps.
- **Always-on render service** (imgproxy pattern): ~10 MB idle for subprocess/combined, ~77 MB for fitz (MuPDF loaded). First request on fitz-svc is warm; no CLI-style cold start per job.

Docker images (bookworm-slim + apt packages): estimated **~250–350 MB** for combined, **~300–400 MB** for fitz (includes `libmupdf`).

## Deployment model comparison

### Current: Node executors on Railway serverless

```typescript
// .railway/railway.ts (excerpt)
deploy: { sleepApplication: true },
RAILPACK_DEPLOY_APT_PACKAGES: "ffmpeg poppler-utils", // PDF executor
```

- Claim → download → render (in-process subprocess) → upload → complete
- Scales to zero when idle; cold start on next job
- Apt packages installed at deploy via Railpack

### imgproxy pattern (reference)

```typescript
// .railway/railway.ts
const Imgproxy = service("Shutter-Imgproxy", {
  source: image("ghcr.io/imgproxy/imgproxy:v4.0.3", { autoUpdates: { type: "disabled" } }),
  replicas: { [region]: 1 },
  healthcheck: "/health",
  networking: { privateNetworkEndpoint: "shutter-imgproxy" },
  // always-on, no sleepApplication
});
```

Private network endpoint, health check, pinned container image, no public domain.

### Proposed: `Shutter-Render` always-on Go service

Sketch (not applied to `.railway/railway.ts` — experiment only):

```typescript
const Render = service("Shutter-Render", {
  source: image("ghcr.io/traydr/shutter-render:fitz-v1", {
    autoUpdates: { type: "disabled" },
  }),
  replicas: { [region]: 1 },
  healthcheck: "/health",
  healthcheckTimeout: 30,
  networking: { privateNetworkEndpoint: "shutter-render" },
  env: {
    PORT: "8080",
    // Optional: bearer token for executor → render calls
    RENDER_SECRET: preserve(),
  },
});
```

Executor env addition:

```typescript
RENDER_BASE_URL: `http://\${{Shutter-Render.RAILWAY_PRIVATE_DOMAIN}}:8080`,
RENDER_SECRET: preserve(),
```

**Railway config implications:**

| Model | Pros | Cons |
|-------|------|------|
| Keep Node executors + subprocess | No new service; proven | No perf win; cold start remains |
| Node executors + Go render sidecar | PDF −55% with fitz; video −13–25%; executor stays thin | +1 always-on service (~$5–15/mo); fitz needs CGO image |
| Replace executors entirely with Go | Single binary; lower memory than Node | Rewrite claim/upload/S3 loop; lose `@shutter/executor-runtime` |
| Combined PDF+video render service | One private endpoint (like imgproxy) | Video still needs ffmpeg in container |

**Recommendation:** Deploy **`combined-svc`** if you want a low-risk win without CGO (PDF −13%, video −13–25%). Deploy **`fitz-svc`** if PDF throughput is the bottleneck and ~77 MB idle memory is acceptable. Do **not** migrate to Go subprocess-only — it matches Node performance with no benefit.

## Integration with `@shutter/executor-runtime`

Current flow (`packages/executor-runtime`):

1. `runExecutorOnce` claims job from Control
2. Processor downloads source to temp dir
3. Processor renders preview bytes + dimensions
4. Runtime uploads to R2, completes job

**Minimal integration (recommended prototype path):**

Replace `processPdfPreview` / `processVideoPreview` subprocess calls with an HTTP POST to the render service:

```typescript
// Pseudocode — apps/executor-pdf/src/processor.ts
const response = await fetch(`${process.env.RENDER_BASE_URL}/render`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.RENDER_SECRET}` },
  body: JSON.stringify({ path: inputPath, kind: "pdf" }),
});
const bytes = new Uint8Array(await response.arrayBuffer());
const width = Number(response.headers.get("X-Render-Width"));
const height = Number(response.headers.get("X-Render-Height"));
```

Effort: **~1–2 days** — add env vars to Railway IaC, auth middleware on Go service, swap processor implementations, integration tests.

**Full Go executor:** reimplement claim/complete/S3 in Go. Effort: **~1–2 weeks**; duplicates `executor-runtime` logic.

## Pros / cons vs staying on Node.js

| | Stay on Node.js | Go render sidecar (fitz + combined) |
|--|-----------------|-------------------------------------|
| PDF perf | 243 ms median | 104–209 ms |
| Video perf | 144–222 ms | 108–200 ms |
| Ops complexity | 2 sleeping Node services | +1 always-on container |
| Deploy | Railpack + apt packages | Docker image (CGO for fitz) |
| Cold start | Node + subprocess per wake | Render service always warm |
| Code sharing | Full TypeScript monorepo | Render logic in Go; orchestration stays TS |
| Risk | Known production path | New service to monitor; MuPDF fidelity testing needed |

### When to stay on Node.js

- Job volume is low enough that 100–200 ms render time is irrelevant vs download/upload
- Team prefers zero new infrastructure
- PDFs include exotic features MuPDF may render differently (forms, annotations, CMYK)

### When to adopt Go

- PDF preview latency is user-visible and frequent
- Willing to run an imgproxy-style always-on private service
- Want to consolidate render tooling out of Node executors (smaller Railpack images, fewer apt packages on executors)

## Files

| Path | Purpose |
|------|---------|
| `cmd/subprocess-svc/` | Option A HTTP service |
| `cmd/combined-svc/` | Option C HTTP service |
| `cmd/fitz-svc/` | Option B HTTP service |
| `cmd/render-cli/` | CLI for benchmarks |
| `internal/render/` | Shared render pipelines |
| `internal/httpapi/` | HTTP handler |
| `benchmark-go.mjs` | Benchmark harness |
| `results/go-benchmark.json` | Raw benchmark output |
| `Dockerfile.combined`, `Dockerfile.fitz` | Deployment sketches |
| `railway-sketch.ts` | IaC snippet (not wired) |

## Reproduce

```bash
cd experiments/executor-perf/go-services
go mod tidy && mkdir -p bin
go build -o bin/render-cli ./cmd/render-cli
go build -o bin/subprocess-svc ./cmd/subprocess-svc
go build -o bin/combined-svc ./cmd/combined-svc
CGO_ENABLED=1 go build -o bin/fitz-svc ./cmd/fitz-svc

PORT=8091 ./bin/subprocess-svc &
PORT=8092 ./bin/combined-svc &
PORT=8093 ./bin/fitz-svc &

node benchmark-go.mjs --iterations 5 --warmup 1 --mode all
```
