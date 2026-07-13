package render

import (
	"context"
	"encoding/json"
	"fmt"
	"image"
	_ "image/png"
	"os"
	"time"
)

type ffprobeOutput struct {
	Streams []struct {
		Width  int `json:"width"`
		Height int `json:"height"`
	} `json:"streams"`
}

func probeDimensions(ctx context.Context, path string, steps *[]StepTiming) (int, int, error) {
	out, d, err := run(ctx, "ffprobe", "ffprobe",
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height",
		"-of", "json",
		path,
	)
	if err != nil {
		return 0, 0, err
	}
	if steps != nil {
		appendStep(steps, "ffprobe", d)
	}
	var parsed ffprobeOutput
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		return 0, 0, err
	}
	if len(parsed.Streams) == 0 || parsed.Streams[0].Width == 0 || parsed.Streams[0].Height == 0 {
		return 0, 0, fmt.Errorf("ffprobe: dimensions unavailable")
	}
	return parsed.Streams[0].Width, parsed.Streams[0].Height, nil
}

func imageFileDimensions(path string, steps *[]StepTiming) (int, int, error) {
	start := time.Now()
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0, err
	}
	if steps != nil {
		appendStep(steps, "image_decode_config", time.Since(start))
	}
	return cfg.Width, cfg.Height, nil
}
