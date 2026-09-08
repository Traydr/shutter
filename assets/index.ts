import { faviconIco, faviconSvg } from "./generated.js";

export function faviconSvgResponse(): Response {
  return new Response(faviconSvg, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}

export function faviconIcoResponse(): Response {
  return new Response(faviconIco, {
    headers: {
      "content-type": "image/x-icon",
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
    },
  });
}
