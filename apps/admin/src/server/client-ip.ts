/** The lockout key for a login attempt: the client address when the proxy in front is trusted. */
export function clientAddress(request: Request, trustProxyHeaders: boolean): string {
  if (!trustProxyHeaders) return "direct";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded !== undefined && forwarded.length > 0) return forwarded;
  return request.headers.get("x-real-ip") ?? "direct";
}
