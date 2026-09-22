import { cors } from "hono/cors";

/**
 * Every delivery response is readable from any origin (ADR 0030). The URL is
 * the authorization: a public URL is public, and a private one carries its
 * token. The Edge never reads a cookie, so `*` without credentials grants
 * nothing that possession of the URL did not already grant. The preflight
 * admits the range and conditional headers Source Delivery forwards, and the
 * exposed headers are the ones a range-capable client such as pdf.js reads.
 * `hono/cors` sets `Access-Control-Allow-Origin` on every response the route
 * returns, including 4xx and 5xx, so a fetch caller sees the status instead
 * of a network error.
 */
export const deliveryCors = cors({
  origin: "*",
  allowMethods: ["GET", "HEAD"],
  allowHeaders: ["Range", "If-Range", "If-None-Match", "If-Modified-Since"],
  exposeHeaders: ["Accept-Ranges", "Content-Length", "Content-Range", "ETag", "Last-Modified"],
  maxAge: 86_400,
});
