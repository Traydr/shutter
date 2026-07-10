# Keep uploads outside Shutter

Shutter does not expose an upload API, issue direct-upload grants, or coordinate
upload completion. Each consuming application owns its upload flow and presents
Shutter only with an already completed Source Object when requesting a
Rendition. This keeps Shutter focused on image optimization and stored video or
PDF thumbnails without coupling it to application-specific upload rules.
