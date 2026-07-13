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
		port = "8093"
	}

	srv := &httpapi.Server{
		Name:          "render-fitz",
		PDFRenderer:   render.FitzPDF,
		VideoRenderer: render.FitzVideo,
	}
	log.Printf("fitz-svc listening on :%s", port)
	if err := httpapi.ListenAndServe(srv, port); err != nil {
		log.Fatal(err)
	}
}
