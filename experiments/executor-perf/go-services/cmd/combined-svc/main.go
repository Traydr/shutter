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
		port = "8092"
	}

	srv := &httpapi.Server{
		Name:          "render-combined",
		PDFRenderer:   render.CombinedPDF,
		VideoRenderer: render.CombinedVideo,
	}
	log.Printf("combined-svc listening on :%s", port)
	if err := httpapi.ListenAndServe(srv, port); err != nil {
		log.Fatal(err)
	}
}
