# Materialize one Master Preview per video or PDF

Each video or PDF Rendition Job creates one canonical high-quality Master
Preview in the Rendition Store. Responsive poster and cover sizes are on-demand
Image Optimizations of that master, using the same normalized Unpic and imgproxy
path as ordinary images. This avoids repeating expensive ffmpeg or PDF rendering
for every frontend width and avoids a second responsive-delivery system. The v1
master is a quality-90 WebP within 1920 pixels, using the one-second video frame
with first-frame fallback or the PDF's first page.

Amended: "within 1920 pixels" means the longest edge is at most 1920 pixels.
The first Executors capped only the width, so a portrait 4K video became a
1920x3414 master and an A0 page 1920x2714. Masters now fit a 1920x1920 box,
keep their aspect ratio, and are never enlarged.
