import { createCsrfMiddleware, createMiddleware, createStart } from "@tanstack/react-start";
import { applySecurityHeaders } from "./server/security-headers";

/**
 * Server functions are same-origin RPC endpoints. Start's middleware refuses a
 * call whose Sec-Fetch-Site, Origin, or Referer says another site sent it; the
 * session guard repeats the check per call as a second lock.
 */
const csrf = createCsrfMiddleware({ filter: (context) => context.handlerType === "serverFn" });

const securityHeaders = createMiddleware().server(async ({ next }) => {
  const result = await next();
  if (result instanceof Response) {
    applySecurityHeaders(result.headers);
  } else if (result.response instanceof Response) {
    applySecurityHeaders(result.response.headers);
  }
  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrf, securityHeaders],
}));
