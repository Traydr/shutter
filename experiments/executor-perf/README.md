# Executor Thumbnail Performance Experiments

Benchmark harness and results for PDF and video thumbnail executor performance exploration.

## Fixtures

- `fixtures/sample-10page.pdf` — 10-page text PDF
- `fixtures/sample-1080p-30s.mp4` — 1080p H.264, 30 seconds
- `fixtures/sample-720p-10s.mp4` — 720p H.264, 10 seconds

## Running benchmarks

```bash
node experiments/executor-perf/benchmark.mjs --iterations 5 --warmup 1
```

Results are written to `experiments/executor-perf/results/`.

## Experiment tracks

1. **native-libs** — Performance improvements within the existing Node.js + subprocess stack
2. **go-services** — Go service prototypes (imgproxy-style)

See `docs/executor-perf-exploration.md` for consolidated findings and recommendations.
