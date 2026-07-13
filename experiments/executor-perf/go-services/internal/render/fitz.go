package render

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"time"

	"github.com/chai2010/webp"
	"github.com/gen2brain/go-fitz"
)

// FitzPDF renders page 1 with MuPDF (go-fitz) then encodes to WebP.
// For images within 1920px, encoding is done in-process without ffmpeg.
func FitzPDF(ctx context.Context, inputPath, workDir string) (*Result, error) {
	start := time.Now()
	var steps []StepTiming

	renderStart := time.Now()
	doc, err := fitz.New(inputPath)
	if err != nil {
		return nil, fmt.Errorf("fitz open: %w", err)
	}
	defer doc.Close()

	if doc.NumPage() < 1 {
		return nil, fmt.Errorf("pdf has no pages")
	}

	img, err := doc.ImageDPI(0, 150)
	if err != nil {
		return nil, fmt.Errorf("fitz render: %w", err)
	}
	appendStep(&steps, "fitz_render", time.Since(renderStart))

	srcBounds := img.Bounds()
	srcW, srcH := srcBounds.Dx(), srcBounds.Dy()
	outW, outH := scaleDimensions(srcW, srcH, 1920)

	if srcW <= 1920 {
		encodeStart := time.Now()
		var buf bytes.Buffer
		if err := webp.Encode(&buf, img, &webp.Options{Quality: 90}); err != nil {
			return nil, fmt.Errorf("webp encode: %w", err)
		}
		appendStep(&steps, "webp_encode", time.Since(encodeStart))
		return &Result{
			Bytes:   buf.Bytes(),
			Width:   outW,
			Height:  outH,
			Steps:   steps,
			TotalMs: ms(time.Since(start)),
		}, nil
	}

	pngPath := filepath.Join(workDir, "fitz-page.png")
	outputPath := filepath.Join(workDir, "out.webp")

	saveStart := time.Now()
	f, err := os.Create(pngPath)
	if err != nil {
		return nil, err
	}
	if err := png.Encode(f, img); err != nil {
		f.Close()
		return nil, err
	}
	f.Close()
	appendStep(&steps, "png_write", time.Since(saveStart))

	_, d, err := run(ctx, "ffmpeg", "ffmpeg",
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

// FitzVideo reuses the combined ffmpeg pipeline for video thumbnails.
func FitzVideo(ctx context.Context, inputPath, workDir string) (*Result, error) {
	return CombinedVideo(ctx, inputPath, workDir)
}

// Ensure image.Image is referenced for go-fitz return type.
var _ image.Image = (image.Image)(nil)
