# Executor Thumbnail Performance Exploration

**Date:** 2026-07-13  
**Scope:** PDF and video thumbnail executors (`apps/executor-pdf`, `apps/executor-video`)  
**Method:** Two independent experiment tracks with shared fixtures and benchmark harness

## Executive summary

We explored two directions for improving thumbnail render latency:

1. **Native library / CLI optimizations** within the existing Node.js + subprocess stack
2. **Go render services** modeled after the imgproxy always-on sidecar pattern

Both tracks ran against the same fixtures with 5-iteration benchmarks (1 warmup). Production baselines: **PDF ~243 ms**, **video 1080p ~222 ms**, **video 720p ~144 ms** (render only, excluding download/upload).

### Recommended path (phased)

| Phase | Change | Effort | PDF gain | Video gain | Risk |
|-------|--------|--------|----------|------------|------|
| **1 — Do now** | Replace `ffprobe` with `webpmux -info`; add `webp` apt package | ~2 hours | −15% | −12–23% | Very low |
| **2 — PDF pipeline** | Switch PDF render to `mutool draw` piped into `ffmpeg` | ~1 day | −40% (total ~−50% with phase 1) | — | Low–medium |
| **3 — Optional sidecar** | Deploy Go `combined-svc` as private `Shutter-Render` service | ~2 days | −13% (redundant if phase 2 done) | −13–25% | Medium |
| **3-alt — PDF throughput** | Deploy Go `fitz-svc` (MuPDF in-process) instead of phase 2 | ~3 days | −55% | −15% | Medium (CGO, AGPL, fidelity) |

**Do not pursue:** Go subprocess-only migration (0% gain vs Node), ffmpeg direct PDF input, hardware decode on Railway, `-skip_frame nokey` without fallback, `thumbnail` ffmpeg filter.

---

## Current architecture

```text
Control ──wake──► Node executor (serverless, sleeps when idle)
                    │
                    ├─ download source to temp dir
                    ├─ subprocess pipeline (pdfinfo/pdftoppm/ffmpeg/ffprobe)
                    ├─ upload master WebP to R2
                    └─ complete job
```

**Bottlenecks identified:**

- PDF uses a two-stage render (`pdftoppm` → PNG on disk → `ffmpeg` → WebP) plus slow `ffprobe` dimension read
- Video spends ~35 ms on `ffprobe` after ffmpeg encode
- Node `spawn` overhead is negligible compared to ffmpeg/poppler (~5 ms vs ~200 ms)
- Serverless cold starts are a separate latency concern not measured in these benchmarks

---

## Track 1: Native library / CLI optimizations

**Branch:** `cursor/executor-perf-native-libs-c454`  
**Artifacts:** `experiments/executor-perf/native-libs/`

### Approaches tested (20 total)

**PDF (11):** baseline, baseline+webpmux, mutool pipe/file, ghostscript JPEG/PNG pipe, pdftocairo PNG, 100 DPI pdftoppm, plus re-tested failures (ffmpeg direct, gs webp, pdftocairo webp)

**Video (9 × 2 resolutions):** baseline±ffprobe, input/fast/output seek, skip_frame nokey, fast+nokey, thumbnail filter, VAAPI hw decode

### Results

| Workload | Baseline | Best approach | Median | Improvement |
|----------|----------|---------------|--------|-------------|
| PDF | 243 ms | `gs` JPEG pipe → ffmpeg → webpmux | **135 ms** | **−44%** |
| PDF (alt) | 243 ms | `mutool draw` pipe → ffmpeg → webpmux | **147 ms** | **−40%** |
| Video 1080p | 222 ms | ffmpeg seek + webpmux (no ffprobe) | **195 ms** | **−12%** |
| Video 720p | 144 ms | ffmpeg seek + webpmux | **112 ms** | **−22%** |

Cross-cutting: **`webpmux -info` replaces `ffprobe`** (~30–40 ms saved per job).

### Pros

- Stays in TypeScript monorepo — no new services
- Incremental adoption (phase 1 is a one-line tool swap per executor)
- Largest PDF win without CGO or Docker images
- Prototype processors ready in `experiments/executor-perf/native-libs/prototypes/`

### Cons

- `mutool` and `ghostscript` are AGPL — review for compliance
- MuPDF may render some PDFs differently than Poppler (forms, annotations, CMYK)
- Piping between processes requires careful `stdout.pipe(stdin)` handling (Node spawn deadlock if misconfigured)
- Still pays subprocess startup per command

### Track 1 recommendation

**Adopt phases 1 and 2 in Node executors.** Phase 1 (`webpmux`) is the highest ROI per line changed. Phase 2 (`mutool draw` pipe) is the best PDF-specific win without leaving the current stack. Prefer `mutool` over `ghostscript` — similar performance, and it aligns with the Go `fitz-svc` path if you later adopt a sidecar.

---

## Track 2: Go render services

**Branch:** `cursor/executor-perf-go-services-c454`  
**Artifacts:** `experiments/executor-perf/go-services/`

### Approaches built

| Service | Model | PDF pipeline | Video pipeline |
|---------|-------|--------------|----------------|
| `subprocess-svc` | Thin Go wrapper | Same as production | Same as production |
| `combined-svc` | Optimized sidecar | Drops ffprobe; in-process dimension probe | Drops ffprobe |
| `fitz-svc` | MuPDF CGO | go-fitz render + in-process WebP | ffmpeg (no pure-Go decoder) |

All expose `GET /health` and `POST /render` for testing.

### Results (median ms vs Node baseline)

| Fixture | Node | Go subprocess | Go combined | Go fitz |
|---------|------|---------------|-------------|---------|
| PDF | 243 | 242 (~0%) | 212 (−13%) | **110 (−55%)** |
| Video 1080p | 222 | 239 (+8%) | 206 (−13%) | 189 (−15%) |
| Video 720p | 144 | 141 (~0%) | **108 (−25%)** | 114 (−21%) |

HTTP overhead on warm services: **< 5 ms**.

### Resource profile

| Binary | Idle RSS | Notes |
|--------|----------|-------|
| subprocess/combined | ~10 MB | Comparable to imgproxy footprint |
| fitz-svc | ~77 MB | MuPDF loaded in memory |

Docker images: ~250–350 MB (combined), ~300–400 MB (fitz with libmupdf).

### Pros

- **fitz-svc** delivers the largest PDF win (−55%) with always-on warm process
- **combined-svc** is a low-risk imgproxy-style sidecar for video (−13–25%) without CGO
- Render logic isolated from executor orchestration — executors stay thin
- Go binary cold start faster than Node for CLI-style invocations (fitz: 114 ms vs subprocess 253 ms)

### Cons

- Go subprocess-only matches Node — **no reason to migrate orchestration alone**
- New always-on service adds ops cost (~$5–15/mo on Railway) and monitoring surface
- `fitz-svc` requires CGO + custom Docker image (can't use Railpack alone)
- Integration requires env vars, auth, and processor swap (~1–2 days)
- Full Go executor rewrite duplicates `@shutter/executor-runtime` (~1–2 weeks) — not recommended
- Video still needs ffmpeg in the container regardless of Go

### Track 2 recommendation

**Do not replace Node executors with Go subprocess wrappers.** If infrastructure investment is acceptable, deploy **`combined-svc`** as a private `Shutter-Render` sidecar for video gains and as a stepping stone. Deploy **`fitz-svc`** only if PDF preview latency is a top-level product concern and ~77 MB idle memory is acceptable — otherwise the Node `mutool` pipe path (track 1) achieves similar PDF gains without a new service.

---

## Comparative decision matrix

| Criterion | Node + native libs (phases 1–2) | Go combined sidecar | Go fitz sidecar |
|-----------|--------------------------------|---------------------|-----------------|
| PDF latency | ~147 ms (−40%) | ~212 ms (−13%) | **~110 ms (−55%)** |
| Video latency | ~112–195 ms (−12–23%) | **~108–206 ms (−13–25%)** | ~114–189 ms |
| New infrastructure | None | +1 always-on service | +1 always-on service (CGO) |
| Code changes | Processor files only | Processor → HTTP client | Processor → HTTP client |
| Deploy complexity | Apt package additions | Docker image + Railway IaC | Docker image + CGO build |
| Licensing | AGPL (mutool) | Same subprocess deps | AGPL (MuPDF) |
| Team familiarity | TypeScript monorepo | Go + TypeScript split | Go + TypeScript split |
| Cold start impact | Unchanged (executor still sleeps) | Render path always warm | Render path always warm |

---

## What we would not recommend

| Approach | Why |
|----------|-----|
| Go subprocess-only executor | 0% improvement over Node for same pipeline |
| ffmpeg direct PDF input | Ubuntu ffmpeg lacks PDF demuxer |
| ghostscript/pdftocairo WebP output | Not supported in distro packages |
| `-skip_frame nokey` | Produces corrupt output on short videos |
| VAAPI/CUDA hardware decode | No GPU on Railway serverless |
| `thumbnail` ffmpeg filter | 2–4× slower (decodes many frames) |
| 100 DPI pdftoppm | Undersized output (850×1100 vs 1275×1650) |
| Full Go executor rewrite | High effort, duplicates runtime, marginal gain |

---

## Suggested implementation plan

### Phase 1 — Quick wins (this week)

1. Add `webp` to `RAILPACK_DEPLOY_APT_PACKAGES` on both executors
2. Replace `ffprobe` calls with `webpmux -info` parsing in `processor.ts` files
3. Add unit tests for dimension parsing

**Expected:** −15% PDF, −12–23% video, zero architectural change.

### Phase 2 — PDF pipeline (next sprint)

1. Add `mupdf-tools` to PDF executor apt packages
2. Replace `pdftoppm` + disk PNG with `mutool draw` piped to `ffmpeg` stdin
3. Run fidelity tests on production PDF samples (forms, scanned docs, CMYK)
4. Keep `pdfinfo` for encryption/page validation

**Expected:** PDF render ~147 ms (−40% from baseline, −50% cumulative with phase 1).

### Phase 3 — Optional sidecar (if video latency matters)

1. Build and pin `combined-svc` Docker image
2. Add `Shutter-Render` service to `.railway/railway.ts` (imgproxy pattern)
3. Swap video `processor.ts` to POST `/render` on private network
4. Monitor latency, memory, error rates

**Expected:** Video −13–25%; PDF benefit redundant if phase 2 shipped.

---

## Experiment artifacts

| Path | Contents |
|------|----------|
| `experiments/executor-perf/benchmark.mjs` | Shared baseline harness |
| `experiments/executor-perf/results/baseline.json` | Production pipeline numbers |
| `experiments/executor-perf/native-libs/` | CLI optimization experiments + prototypes |
| `experiments/executor-perf/go-services/` | Go service prototypes + Docker/Railway sketches |
| `experiments/executor-perf/native-libs/RESULTS.md` | Track 1 detailed results |
| `experiments/executor-perf/go-services/RESULTS.md` | Track 2 detailed results |

### Reproduce

```bash
# Baseline
node experiments/executor-perf/benchmark.mjs --iterations 5 --warmup 1

# Native libs
node experiments/executor-perf/native-libs/benchmark.mjs --iterations 5 --warmup 1

# Go services
cd experiments/executor-perf/go-services && go build ./... && node benchmark-go.mjs --mode all
```

---

## Final recommendation

**Primary:** Implement phases 1 and 2 in the existing Node executors. This delivers the best effort-to-impact ratio — up to ~50% faster PDF renders and ~20% faster video renders with no new services, minimal risk, and changes confined to processor files plus apt packages.

**Secondary (optional):** If video preview latency remains a concern after phase 1, add a Go `combined-svc` sidecar following the imgproxy deployment pattern. Skip Go subprocess-only migration entirely.

**Tertiary (PDF at scale):** If PDF throughput becomes a bottleneck after phase 2, evaluate `fitz-svc` as an always-on sidecar — but only after fidelity testing confirms MuPDF output matches Poppler for your PDF corpus. The Node `mutool` pipe path may be sufficient without this added complexity.
