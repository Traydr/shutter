# Go render service prototypes

Prototype Go services for PDF and video thumbnail generation, benchmarked against the Node.js subprocess baseline in `../benchmark.mjs`.

## Approaches

| Service | Port | Option | Description |
|---------|------|--------|-------------|
| `subprocess-svc` | 8091 | A | Thin Go wrapper mirroring Node.js pipelines exactly |
| `combined-svc` | 8092 | C | Optimized pipelines: skip ffprobe, in-process dimension probing |
| `fitz-svc` | 8093 | B | MuPDF (go-fitz) for PDF render + in-process WebP encode |

## Build

```bash
cd experiments/executor-perf/go-services
go mod tidy
mkdir -p bin
go build -o bin/render-cli ./cmd/render-cli
go build -o bin/subprocess-svc ./cmd/subprocess-svc
go build -o bin/combined-svc ./cmd/combined-svc
CGO_ENABLED=1 go build -o bin/fitz-svc ./cmd/fitz-svc
```

`fitz-svc` requires `libmupdf-dev` at build time (CGO).

## HTTP API

All services expose:

- `GET /health` — `{"ok":true,"service":"..."}`
- `POST /render` — render thumbnail

Request (JSON):

```json
{ "path": "/absolute/path/to/file.pdf", "kind": "pdf" }
```

Or multipart: `kind=pdf` + `file` upload.

Response: `image/webp` body with headers:

- `X-Render-Width`, `X-Render-Height`
- `X-Render-Total-Ms`
- `X-Render-Steps` (JSON array)

## CLI benchmark

```bash
./bin/render-cli -approach fitz -kind pdf -input ../fixtures/sample-10page.pdf
```

## Run benchmarks

```bash
# Start services (optional, for HTTP mode)
PORT=8091 ./bin/subprocess-svc &
PORT=8092 ./bin/combined-svc &
PORT=8093 ./bin/fitz-svc &

node benchmark-go.mjs --iterations 5 --warmup 1 --mode all
```

Results: `results/go-benchmark.json`. See `RESULTS.md` for analysis.

## Docker

```bash
docker build -f Dockerfile.combined -t shutter-render-combined .
docker build -f Dockerfile.fitz -t shutter-render-fitz .
```
