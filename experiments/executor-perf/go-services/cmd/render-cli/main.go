package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/traydr/shutter/experiments/executor-perf/go-services/internal/render"
)

func main() {
	approach := flag.String("approach", "subprocess", "subprocess|combined|fitz")
	kind := flag.String("kind", "pdf", "pdf|video")
	input := flag.String("input", "", "path to input file")
	flag.Parse()

	if *input == "" {
		fmt.Fprintln(os.Stderr, "input is required")
		os.Exit(2)
	}

	workDir, err := os.MkdirTemp("", "shutter-bench-")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer os.RemoveAll(workDir)

	ctx := context.Background()
	var result *render.Result

	switch *approach {
	case "subprocess":
		if *kind == "pdf" {
			result, err = render.SubprocessPDF(ctx, *input, workDir)
		} else {
			result, err = render.SubprocessVideo(ctx, *input, workDir)
		}
	case "combined":
		if *kind == "pdf" {
			result, err = render.CombinedPDF(ctx, *input, workDir)
		} else {
			result, err = render.CombinedVideo(ctx, *input, workDir)
		}
	case "fitz":
		if *kind == "pdf" {
			result, err = render.FitzPDF(ctx, *input, workDir)
		} else {
			result, err = render.FitzVideo(ctx, *input, workDir)
		}
	default:
		fmt.Fprintf(os.Stderr, "unknown approach %q\n", *approach)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	out := map[string]any{
		"width":   result.Width,
		"height":  result.Height,
		"bytes":   len(result.Bytes),
		"totalMs": result.TotalMs,
		"steps":   result.Steps,
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(out)

	// Write output for verification
	_ = os.WriteFile(filepath.Join(workDir, "out.webp"), result.Bytes, 0o644)
}
