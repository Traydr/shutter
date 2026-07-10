# Use a TypeScript pnpm workspace

Shutter uses TypeScript and pnpm across a Hono Node control service, a web-native
Hono Cloudflare Worker, separate Node video and PDF Executors, and shared
contracts and capability code. Drizzle and Postgres persist Rendition Jobs, an
S3-compatible Railway Bucket stores Renditions, and imgproxy remains a separate
container deployment. The Worker uses native Web Crypto and Cache APIs without
Node compatibility, while executor-only packages may use Node, ffmpeg, sharp,
and PDF libraries. This matches both consuming applications and permits shared
types without forcing Node dependencies into the edge bundle.
