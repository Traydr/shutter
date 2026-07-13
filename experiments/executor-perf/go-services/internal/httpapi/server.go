package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/traydr/shutter/experiments/executor-perf/go-services/internal/render"
)

type PDFRenderer func(ctx context.Context, inputPath, workDir string) (*render.Result, error)
type VideoRenderer func(ctx context.Context, inputPath, workDir string) (*render.Result, error)

type Server struct {
	Name         string
	PDFRenderer  PDFRenderer
	VideoRenderer VideoRenderer
}

type renderRequest struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type renderResponse struct {
	Width   int                `json:"width"`
	Height  int                `json:"height"`
	Bytes   int                `json:"bytes"`
	TotalMs float64            `json:"totalMs"`
	Steps   []render.StepTiming `json:"steps,omitempty"`
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /render", s.handleRender)
	return mux
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "service": s.Name})
}

func (s *Server) handleRender(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), render.DefaultTimeout)
	defer cancel()

	workDir, err := os.MkdirTemp("", "shutter-render-")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(workDir)

	inputPath, kind, cleanup, err := resolveInput(r, workDir)
	if cleanup != nil {
		defer cleanup()
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	var result *render.Result
	switch kind {
	case "pdf":
		if s.PDFRenderer == nil {
			http.Error(w, "pdf rendering not supported", http.StatusBadRequest)
			return
		}
		result, err = s.PDFRenderer(ctx, inputPath, workDir)
	case "video":
		if s.VideoRenderer == nil {
			http.Error(w, "video rendering not supported", http.StatusBadRequest)
			return
		}
		result, err = s.VideoRenderer(ctx, inputPath, workDir)
	default:
		http.Error(w, "kind must be pdf or video", http.StatusBadRequest)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}

	w.Header().Set("Content-Type", "image/webp")
	w.Header().Set("X-Render-Width", fmt.Sprintf("%d", result.Width))
	w.Header().Set("X-Render-Height", fmt.Sprintf("%d", result.Height))
	w.Header().Set("X-Render-Total-Ms", fmt.Sprintf("%.3f", result.TotalMs))
	if len(result.Steps) > 0 {
		stepsJSON, _ := json.Marshal(result.Steps)
		w.Header().Set("X-Render-Steps", string(stepsJSON))
	}
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(result.Bytes)))
	_, _ = w.Write(result.Bytes)
}

func resolveInput(r *http.Request, workDir string) (inputPath, kind string, cleanup func(), err error) {
	contentType := r.Header.Get("Content-Type")
	if strings.HasPrefix(contentType, "multipart/form-data") {
		if err := r.ParseMultipartForm(600 << 20); err != nil {
			return "", "", nil, err
		}
		kind = r.FormValue("kind")
		file, header, err := r.FormFile("file")
		if err != nil {
			return "", "", nil, err
		}
		defer file.Close()
		ext := filepath.Ext(header.Filename)
		if ext == "" {
			if kind == "pdf" {
				ext = ".pdf"
			} else {
				ext = ".mp4"
			}
		}
		dest := filepath.Join(workDir, "upload"+ext)
		out, err := os.Create(dest)
		if err != nil {
			return "", "", nil, err
		}
		if _, err := io.Copy(out, file); err != nil {
			out.Close()
			return "", "", nil, err
		}
		out.Close()
		return dest, kind, nil, nil
	}

	var req renderRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return "", "", nil, err
	}
	if req.Path == "" || req.Kind == "" {
		return "", "", nil, fmt.Errorf("path and kind are required")
	}
	return req.Path, req.Kind, nil, nil
}

func WriteJSONRenderMeta(w http.ResponseWriter, result *render.Result) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(renderResponse{
		Width:   result.Width,
		Height:  result.Height,
		Bytes:   len(result.Bytes),
		TotalMs: result.TotalMs,
		Steps:   result.Steps,
	})
}

func ListenAndServe(s *Server, port string) error {
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      render.DefaultTimeout,
		IdleTimeout:       2 * time.Minute,
	}
	return srv.ListenAndServe()
}
