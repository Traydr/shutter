# Materialize one Master Preview per video or PDF

Each video or PDF Rendition Job creates one canonical high-quality Master
Preview in the Rendition Store. Responsive poster and cover sizes are on-demand
Image Optimizations of that master, using the same normalized Unpic and imgproxy
path as ordinary images. This avoids repeating expensive ffmpeg or PDF rendering
for every frontend width and avoids a second responsive-delivery system. The v1
master is a quality-90 WebP within 1920 pixels, using the one-second video frame
with first-frame fallback or the PDF's first page.
