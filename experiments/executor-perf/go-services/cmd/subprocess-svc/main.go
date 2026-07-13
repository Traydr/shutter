package main

import (
	"log"
	"os"

	"github.com/traydr/shutter/experiments/executor-perf/go-services/internal/httpapi"
	"github.com/traydr/shutter/experiments/executor-perf/go-services/internal/render"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8091"
	}

	srv := &httpapi.Server{
		Name:          "render-subprocess",
		PDFRenderer:   render.SubprocessPDF,
		VideoRenderer: render.SubprocessVideo,
	}
	log.Printf("subprocess-svc listening on :%s", port)
	if err := httpapi.ListenAndServe(srv, port); err != nil {
		log.Fatal(err)
	}
}
