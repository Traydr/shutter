# Store Shutter Renditions in Cloudflare R2

Shutter stores cached Image Optimizations and durable Master Previews in R2,
while consuming applications keep Source Objects in their existing storage.
The Cloudflare Worker reads R2 through a native binding after authorization and
Railway Executors write through R2's S3-compatible API. Separate cache and
master prefixes permit lifecycle expiry for disposable outputs and explicit
purge for durable previews, reducing Railway origin traffic without coupling
Source Object storage to Cloudflare.
