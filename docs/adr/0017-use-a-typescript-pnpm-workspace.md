# Use a TypeScript pnpm workspace

Shutter uses TypeScript and pnpm across a Hono Node control service, a web-native
Hono Cloudflare Worker, separate Node video and PDF Executors, and shared
contracts and capability code. Drizzle and Postgres persist Rendition Jobs, an
R2 bucket stores Renditions, and imgproxy remains a separate container
deployment. The Worker uses native Web Crypto, Cache, and R2 binding APIs
without Node compatibility, while executor-only packages may use Node, ffmpeg,
sharp, PDF libraries, and R2's S3 API. This matches both consuming applications
and permits shared types without forcing Node dependencies into the edge bundle.
