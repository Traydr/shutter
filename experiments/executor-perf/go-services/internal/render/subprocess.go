package render

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// SubprocessPDF mirrors the Node.js executor-pdf pipeline:
// pdfinfo → pdftoppm → ffmpeg → ffprobe.
func SubprocessPDF(ctx context.Context, inputPath, workDir string) (*Result, error) {
	start := time.Now()
	var steps []StepTiming

	info, d, err := run(ctx, "pdfinfo", "pdfinfo", inputPath)
	if err != nil {
		return nil, fmt.Errorf("pdf metadata: %w", err)
	}
	appendStep(&steps, "pdfinfo", d)
	if strings.Contains(strings.ToLower(info), "encrypted:       yes") ||
		strings.Contains(strings.ToLower(info), "encrypted: yes") {
		return nil, fmt.Errorf("pdf is encrypted")
	}

	pagePrefix := filepath.Join(workDir, "page")
	outputPath := filepath.Join(workDir, "out.webp")

	_, d, err = run(ctx, "pdftoppm", "pdftoppm", "-f", "1", "-singlefile", "-png", "-r", "150", inputPath, pagePrefix)
	if err != nil {
		return nil, fmt.Errorf("pdftoppm: %w", err)
	}
	appendStep(&steps, "pdftoppm", d)

	_, d, err = run(ctx, "ffmpeg", "ffmpeg",
		"-hide_banner", "-loglevel", "error",
		"-i", pagePrefix+".png",
		"-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
		"-c:v", "libwebp", "-quality", "90", "-y", outputPath,
	)
	if err != nil {
		return nil, fmt.Errorf("ffmpeg: %w", err)
	}
	appendStep(&steps, "ffmpeg", d)

	width, height, err := probeDimensions(ctx, outputPath, &steps)
	if err != nil {
		return nil, err
	}

	bytes, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, err
	}

	return &Result{
		Bytes:   bytes,
		Width:   width,
		Height:  height,
		Steps:   steps,
		TotalMs: ms(time.Since(start)),
	}, nil
}

// SubprocessVideo mirrors the Node.js executor-video pipeline:
// ffmpeg (ss=1 with fallback) → ffprobe.
func SubprocessVideo(ctx context.Context, inputPath, workDir string) (*Result, error) {
	start := time.Now()
	var steps []StepTiming
	outputPath := filepath.Join(workDir, "out.webp")

	_, d, err := run(ctx, "ffmpeg", "ffmpeg", "-ss", "1",
		"-hide_banner", "-loglevel", "error",
		"-i", inputPath,
		"-frames:v", "1",
		"-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
		"-c:v", "libwebp", "-quality", "90", "-y", outputPath,
	)
	if err != nil {
		_, d, err = run(ctx, "ffmpeg", "ffmpeg",
			"-hide_banner", "-loglevel", "error",
			"-i", inputPath,
			"-frames:v", "1",
			"-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
			"-c:v", "libwebp", "-quality", "90", "-y", outputPath,
		)
		if err != nil {
			return nil, fmt.Errorf("ffmpeg: %w", err)
		}
	}
	appendStep(&steps, "ffmpeg", d)

	width, height, err := probeDimensions(ctx, outputPath, &steps)
	if err != nil {
		return nil, err
	}

	bytes, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, err
	}

	return &Result{
		Bytes:   bytes,
		Width:   width,
		Height:  height,
		Steps:   steps,
		TotalMs: ms(time.Since(start)),
	}, nil
}
