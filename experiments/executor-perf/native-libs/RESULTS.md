# Native Library / CLI Optimization Results

Benchmark date: 2026-07-13. Environment: linux/amd64, Node v22.14.0.

Harness: `experiments/executor-perf/native-libs/benchmark.mjs` (5 iterations, 1 warmup).
Fixtures: `sample-10page.pdf`, `sample-1080p-30s.mp4`, `sample-720p-10s.mp4`.
Baseline reference: `../results/baseline.json` (3 iterations, production pipelines).

## Summary

| Area | Production baseline | Best native-lib approach | Median improvement | Recommended adoption |
|------|--------------------|--------------------------|-------------------|----------------------|
| PDF | 243 ms (`pdftoppm` → `ffmpeg` → `ffprobe`) | `gs` JPEG pipe → `ffmpeg` → `webpmux` | **−44%** (135 ms) | **Yes** — see caveats |
| PDF (alt) | 243 ms | `mutool draw` pipe → `ffmpeg` → `webpmux` | **−40%** (147 ms) | **Yes** — preferred if already adding MuPDF |
| Video 1080p | 222 ms (`ffmpeg -ss 1` → `ffprobe`) | same `ffmpeg` + `webpmux` probe | **−12%** (195 ms) | **Yes** — low risk |
| Video 720p | 144 ms | same `ffmpeg` + `webpmux` probe | **−22%** (112 ms) | **Yes** — low risk |

Cross-cutting win: replacing `ffprobe` with `webpmux -info` saves **~30–40 ms** per job with identical dimensions.

## Approaches tested

### PDF (11 approaches)

| Approach | Median | p95 | Output | vs baseline | Notes |
|----------|--------|-----|--------|-------------|-------|
| **Baseline** (`pdftoppm` + `ffmpeg` + `ffprobe`) | 242 ms | 249 ms | 9996 B, 1275×1650 | — | Production pipeline |
| Baseline + `webpmux` probe | 205 ms | 210 ms | 9996 B, 1275×1650 | −15% | Same quality; drops slow `ffprobe` |
| **`gs` JPEG pipe → `ffmpeg`** | **135 ms** | **137 ms** | 9382 B, 1275×1650 | **−44%** | Fastest; JPEG intermediate |
| **`mutool draw` pipe → `ffmpeg`** | **147 ms** | **148 ms** | 10078 B, 1275×1650 | **−40%** | Fast render; pipes via stdout |
| `mutool draw` file → `ffmpeg` | 173 ms | 177 ms | 10078 B, 1275×1650 | −29% | Slower than pipe (disk I/O) |
| `gs` PNG pipe → `ffmpeg` | 185 ms | 185 ms | 9336 B, 1275×1650 | −24% | PNG intermediate slower than JPEG |
| `pdftocairo` PNG → `ffmpeg` | 222 ms | 222 ms | 10090 B, 1275×1650 | −9% | Works; no faster than baseline |
| `pdftoppm` @ 100 DPI → `ffmpeg` | 127 ms | 128 ms | 5848 B, 850×1100 | −48% | **Quality regression** — undersized output |
| `ffmpeg` direct on PDF | FAILED | — | — | — | No PDF demuxer in distro ffmpeg |
| `gs -sDEVICE=webp` | FAILED | — | — | — | Ghostscript 10.x lacks `webp` device |
| `pdftocairo -webp` | FAILED | — | — | — | Poppler 24.x has no WebP output format |

#### Why prior harness approaches failed

1. **`ffmpeg` direct PDF** — Ubuntu ffmpeg 6.1 is built without a PDF input demuxer. Error: `Invalid data found when processing input` (exit 183).
2. **`ghostscript -sDEVICE=webp`** — Debian/Ubuntu Ghostscript 10.02.1 does not ship a `webp` output device (`Unknown device: webp`).
3. **`pdftocairo -webp`** — Poppler utils only support PNG, JPEG, TIFF, PS, EPS, PDF, SVG. The `-webp` flag is not implemented (prints usage, exit 99).

#### PDF step breakdown (best vs baseline)

| Step | Baseline | `gs` JPEG pipe | `mutool` pipe |
|------|----------|----------------|---------------|
| `pdfinfo` | 7 ms | 7 ms | 6 ms |
| Render | 68 ms (`pdftoppm`) | 126 ms (`gs`→`ffmpeg` combined) | 141 ms (`mutool`→`ffmpeg` combined) |
| `ffmpeg` WebP | 134 ms | (included above) | (included above) |
| Dimension probe | 33 ms (`ffprobe`) | 2 ms (`webpmux`) | 1 ms (`webpmux`) |

The win comes from: (a) faster PDF rasterization (`mutool`/`gs` vs `pdftoppm`), (b) eliminating intermediate PNG on disk via stdout pipe, (c) `webpmux` instead of `ffprobe`.

Piping note: Node `spawn` with `stdio: [renderer.stdout, …]` deadlocks; use `renderer.stdout.pipe(ffmpeg.stdin)` (fixed in harness and prototypes).

### Video (9 approaches × 2 resolutions)

#### 1080p / 30 s

| Approach | Median | p95 | Output | vs baseline (222 ms) | Notes |
|----------|--------|-----|--------|----------------------|-------|
| Baseline (`-ss 1` + `ffprobe`) | 231 ms | 233 ms | 68934 B, 1920×1080 | — | Includes ffprobe cost |
| **Baseline seek + `webpmux`** | **195 ms** | **200 ms** | 68934 B, 1920×1080 | **−12%** | Easiest win |
| Input seek (`-ss` before `-i`) + `webpmux` | 191 ms | 195 ms | 68934 B | −14% | Same frame as baseline |
| Fast seek (`-noaccurate_seek`) + `webpmux` | 192 ms | 193 ms | 68806 B | −14% | ~130 B smaller; visually equivalent |
| Output seek (`-ss` after `-i`) + `webpmux` | 196 ms | 212 ms | 68934 B | −12% | Higher p95 variance |
| `-skip_frame nokey` + `webpmux` | 188 ms | 196 ms | 71626 B | −15% | Lands on keyframe; slightly different frame |
| Fast seek + `nokey` + `webpmux` | 187 ms | 189 ms | 71626 B | −16% | Best 1080p; frame may differ |
| `thumbnail` filter + `webpmux` | 506 ms | 803 ms | 70694 B | +128% | **Avoid** — decodes many frames |
| VAAPI hardware decode | FAILED | — | — | — | No `/dev/dri/renderD128` on Railway |

#### 720p / 10 s

| Approach | Median | p95 | Output | vs baseline (144 ms) | Notes |
|----------|--------|-----|--------|----------------------|-------|
| Baseline + `ffprobe` | 146 ms | 148 ms | 37740 B, 1280×720 | — | |
| **Baseline seek + `webpmux`** | **112 ms** | **115 ms** | 37740 B | **−22%** | |
| Input seek + `webpmux` | 111 ms | 112 ms | 37740 B | −23% | |
| Fast seek + `webpmux` | 113 ms | 118 ms | 37354 B | −22% | |
| Output seek + `webpmux` | 117 ms | 119 ms | 37740 B | −19% | |
| `-skip_frame nokey` | **FAILED** | — | — | — | ffmpeg produced invalid/empty WebP |
| Fast seek + `nokey` | **FAILED** | — | — | — | Same failure on short clip |
| `thumbnail` filter | 258 ms | 270 ms | 39556 B | +79% | Avoid |
| VAAPI hardware decode | FAILED | — | — | — | No GPU device |

#### Video observations

- **`webpmux -info`** probes WebP dimensions in **~1–3 ms** vs **~36–40 ms** for `ffprobe`. Safe drop-in for WebP outputs.
- **Seek strategy** matters less than dropping `ffprobe`. Input seek (`-ss` before `-i`) is already optimal for this workload.
- **`-skip_frame nokey`** can produce corrupt output on short videos (720p fixture). Do not adopt without a fallback to normal decode.
- **Hardware decode** (VAAPI/CUDA/QSV) is unavailable in typical Railway containers (no GPU, no DRI device).
- **`thumbnail` filter** forces multi-frame analysis — 2–4× slower.

### General optimizations explored

| Technique | Result |
|-----------|--------|
| Reduce subprocess count (`webpmux` vs `ffprobe`) | **~30–40 ms saved** per job |
| Pipe render → `ffmpeg` (no temp PNG) | **~20–40 ms saved** on PDF |
| Lower DPI then scale (`pdftoppm -r 100`) | Faster but **wrong output dimensions** for this fixture |
| `pdfium` CLI | Not available in Ubuntu apt; skipped |
| Parallel `pdfinfo` + render | Not tested — `pdfinfo` is <7 ms; negligible |

## Output quality / size comparison

All successful PDF approaches at 150 DPI produce **1275×1650** output (page fits within 1920 px width). Byte sizes are within ~8% of baseline:

| Approach | Bytes | Dimensions |
|----------|-------|------------|
| Baseline | 9996 | 1275×1650 |
| `mutool` pipe | 10078 | 1275×1650 |
| `gs` JPEG pipe | 9382 | 1275×1650 |
| `gs` PNG pipe | 9336 | 1275×1650 |
| `pdftocairo` PNG | 10090 | 1275×1650 |
| 100 DPI (rejected) | 5848 | 850×1100 |

Video approaches at 1080p produce **1920×1080** except `nokey` variants (71 626 B, keyframe-aligned frame). Visual difference is minor for thumbnails but frame timestamp may differ.

## Compatibility (Railway / apt / licensing)

| Package | Apt name | Current deploy | Needed for |
|---------|----------|----------------|------------|
| poppler-utils | `poppler-utils` | PDF executor (`RAILPACK_DEPLOY_APT_PACKAGES`) | `pdfinfo`, `pdftoppm` (baseline) |
| ffmpeg | `ffmpeg` | PDF + video executors | WebP encode, video decode |
| webpmux | `webp` | **not currently listed** | Dimension probe (recommended) |
| mupdf-tools | `mupdf-tools` | **not currently listed** | `mutool draw` PDF path |
| ghostscript | `ghostscript` | **not currently listed** | `gs` JPEG PDF path |

Licensing:

- **MuPDF / `mupdf-tools`** — AGPL-3.0. Acceptable for server-side rendering in a hosted service; review if distributing modified MuPDF.
- **Ghostscript** — AGPL-3.0 (artwork exceptions). Same considerations.
- **Poppler** — GPL-2.0 / GPL-3.0 depending on component. Already in stack.
- **webpmux** — BSD-style (libwebp). No concerns.

`pdfium` is not packaged in standard Debian/Ubuntu repos; would require a custom binary or build step.

## Recommendations

### Adopt now (low risk, stays Node + subprocess)

1. **Replace `ffprobe` with `webpmux -info`** in both executors after WebP encode.
   - PDF: 242 ms → 205 ms (−15%) with no pipeline change.
   - Video 1080p: 231 ms → 195 ms (−16%).
   - Video 720p: 146 ms → 112 ms (−23%).
   - Add `webp` to `RAILPACK_DEPLOY_APT_PACKAGES`.

2. **Keep current `ffmpeg` seek** (`-ss 1` before `-i`, first-frame fallback). Other seek tweaks give marginal gains and `nokey` breaks short videos.

### Adopt for PDF (medium effort, largest PDF win)

3. **Switch PDF render to `mutool draw` piped into `ffmpeg`** (prototype: `prototypes/pdf-mutool-pipe.mjs`).
   - 147 ms median (−40% vs 243 ms baseline).
   - Aligns with MuPDF used in the Go `fitz-svc` experiment track.
   - Add `mupdf-tools` to apt packages; keep `poppler-utils` for `pdfinfo` validation.

   **Alternative:** `ghostscript` JPEG pipe (135 ms, −44%). Slightly faster on this fixture but AGPL and another renderer to maintain. Choose one — not both.

### Do not adopt

- `ffmpeg` direct PDF input
- `ghostscript -sDEVICE=webp` / `pdftocairo -webp` (unsupported)
- `thumbnail` ffmpeg filter
- `-skip_frame nokey` without fallback (fails on short clips)
- VAAPI / hardware decode on Railway serverless
- 100 DPI `pdftoppm` (undersized output)
- `pdftocairo` PNG (no speed benefit)

## Prototype processors

Standalone scripts mirroring production processor contracts:

| File | Pipeline |
|------|----------|
| `prototypes/pdf-mutool-pipe.mjs` | `pdfinfo` → `mutool draw \| ffmpeg` → `webpmux` |
| `prototypes/pdf-gs-jpeg-pipe.mjs` | `pdfinfo` → `gs jpeg \| ffmpeg` → `webpmux` |
| `prototypes/video-fast-seek.mjs` | `ffmpeg` (fast seek + nokey with fallbacks) → `webpmux` |

Run example:

```bash
node experiments/executor-perf/native-libs/prototypes/pdf-mutool-pipe.mjs \
  experiments/executor-perf/fixtures/sample-10page.pdf /tmp/out.webp
```

## Raw results

Full JSON: `results/latest.json`

```bash
node experiments/executor-perf/native-libs/benchmark.mjs --iterations 5 --warmup 1
```
