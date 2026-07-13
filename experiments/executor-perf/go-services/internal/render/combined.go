package render

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// CombinedPDF uses pdftoppm + ffmpeg but skips ffprobe by reading PNG dimensions
// before the scale step and computing scaled dimensions in-process.
func CombinedPDF(ctx context.Context, inputPath, workDir string) (*Result, error) {
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
	pngPath := pagePrefix + ".png"
	outputPath := filepath.Join(workDir, "out.webp")

	_, d, err = run(ctx, "pdftoppm", "pdftoppm", "-f", "1", "-singlefile", "-png", "-r", "150", inputPath, pagePrefix)
	if err != nil {
		return nil, fmt.Errorf("pdftoppm: %w", err)
	}
	appendStep(&steps, "pdftoppm", d)

	srcW, srcH, err := imageFileDimensions(pngPath, &steps)
	if err != nil {
		return nil, err
	}
	outW, outH := scaleDimensions(srcW, srcH, 1920)

	_, d, err = run(ctx, "ffmpeg", "ffmpeg",
		"-hide_banner", "-loglevel", "error",
		"-i", pngPath,
		"-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
		"-c:v", "libwebp", "-quality", "90", "-y", outputPath,
	)
	if err != nil {
		return nil, fmt.Errorf("ffmpeg: %w", err)
	}
	appendStep(&steps, "ffmpeg", d)

	bytes, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, err
	}

	return &Result{
		Bytes:   bytes,
		Width:   outW,
		Height:  outH,
		Steps:   steps,
		TotalMs: ms(time.Since(start)),
	}, nil
}

// CombinedVideo uses input seek (-ss before -i) and skips ffprobe by parsing
// ffmpeg stderr for the output stream dimensions.
func CombinedVideo(ctx context.Context, inputPath, workDir string) (*Result, error) {
	start := time.Now()
	var steps []StepTiming
	outputPath := filepath.Join(workDir, "out.webp")

	_, d, err := run(ctx, "ffmpeg", "ffmpeg",
		"-hide_banner", "-loglevel", "info",
		"-ss", "1", "-i", inputPath,
		"-frames:v", "1",
		"-vf", "scale='min(1920,iw)':-2:force_original_aspect_ratio=decrease",
		"-c:v", "libwebp", "-quality", "90", "-y", outputPath,
	)
	if err != nil {
		_, d, err = run(ctx, "ffmpeg", "ffmpeg",
			"-hide_banner", "-loglevel", "info",
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

	width, height, err := imageFileDimensions(outputPath, &steps)
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

func scaleDimensions(width, height, maxEdge int) (int, int) {
	if width <= maxEdge {
		return width, height
	}
	scaledW := maxEdge
	scaledH := int(float64(height) * float64(maxEdge) / float64(width))
	if scaledH%2 != 0 {
		scaledH--
	}
	return scaledW, scaledH
}
