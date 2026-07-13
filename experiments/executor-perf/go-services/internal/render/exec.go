package render

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"time"
)

const DefaultTimeout = 10 * time.Minute

type StepTiming struct {
	Name string  `json:"name"`
	Ms   float64 `json:"ms"`
}

type Result struct {
	Bytes  []byte       `json:"-"`
	Width  int          `json:"width"`
	Height int          `json:"height"`
	Steps  []StepTiming `json:"steps,omitempty"`
	TotalMs float64     `json:"totalMs"`
}

func run(ctx context.Context, name string, command string, args ...string) (string, time.Duration, error) {
	start := time.Now()
	cmd := exec.CommandContext(ctx, command, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if stderr.Len() > 0 {
			return "", 0, fmt.Errorf("%s: %w: %s", command, err, stderr.String())
		}
		return "", 0, fmt.Errorf("%s: %w", command, err)
	}
	return stdout.String(), time.Since(start), nil
}

func runBytes(ctx context.Context, name string, command string, args ...string) ([]byte, time.Duration, error) {
	start := time.Now()
	cmd := exec.CommandContext(ctx, command, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if stderr.Len() > 0 {
			return nil, 0, fmt.Errorf("%s: %w: %s", command, err, stderr.String())
		}
		return nil, 0, fmt.Errorf("%s: %w", command, err)
	}
	return stdout.Bytes(), time.Since(start), nil
}

func ms(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}

func appendStep(steps *[]StepTiming, name string, d time.Duration) {
	*steps = append(*steps, StepTiming{Name: name, Ms: ms(d)})
}
