import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";

/** Every address a hostname resolves to, as dotted or colon notation. */
export type AddressLookup = (hostname: string) => Promise<readonly string[]>;

const defaultLookup: AddressLookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

function ipv4Octets(address: string): readonly number[] | undefined {
  const octets = address.split(".").map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet))
    ? octets
    : undefined;
}

/** Loopback, link-local, private, carrier-grade NAT, unspecified, and multicast ranges. */
function isPrivateIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (octets === undefined) return true;
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

const MAPPED_DOTTED = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/u;
const MAPPED_HEX = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u;

/**
 * The IPv4 address an IPv6 literal embeds: IPv4-mapped (`::ffff:a.b.c.d`, or
 * the hexadecimal spelling `::ffff:7f00:1` a resolver may answer with) and the
 * deprecated IPv4-compatible form (`::a.b.c.d`, `::7f00:1`).
 */
function embeddedIpv4(lower: string): string | undefined {
  const dotted = MAPPED_DOTTED.exec(lower);
  if (dotted !== null) return dotted[1];
  const hex = MAPPED_HEX.exec(lower);
  if (hex === null) return undefined;
  const high = Number.parseInt(hex[1] ?? "0", 16);
  const low = Number.parseInt(hex[2] ?? "0", 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateIpv6(address: string): boolean {
  const lower = address.toLowerCase();
  const embedded = embeddedIpv4(lower);
  if (embedded !== undefined) return isPrivateIpv4(embedded);
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("ff")
  );
}

export function isPrivateAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return isPrivateIpv4(address);
    case 6:
      return isPrivateIpv6(address);
    default:
      return true;
  }
}

/**
 * Refuses a host that is, or resolves to, a private address, and returns the
 * addresses it accepted so the caller can connect to one of exactly those.
 * The allowlist checks origins, not destinations, so this is what keeps the
 * admin Test fetch off Control's own network.
 */
export async function assertPublicHost(
  hostname: string,
  resolve: AddressLookup = defaultLookup,
): Promise<readonly string[]> {
  const bare = hostname.replace(/^\[|\]$/gu, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) {
    throw new Error("the host is loopback");
  }
  const addresses = isIP(bare) === 0 ? await resolve(bare) : [bare];
  if (addresses.length === 0) throw new Error("the host does not resolve");
  if (addresses.some(isPrivateAddress)) throw new Error("the host resolves to a private address");
  return addresses;
}

/**
 * A `net`-style lookup that always answers with one validated address, so the
 * connection cannot follow a DNS answer that differs from the one the guard
 * checked. Node asks with `all` when it selects the address family itself.
 */
export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

/** The status and headers a location answered a one-byte probe with. */
export interface LocationProbe {
  status: number;
  headers: Headers;
}

export type ProbeLocation = (
  locator: string,
  address: string,
  timeoutMs: number,
) => Promise<LocationProbe>;

/**
 * Fetches the first byte of an HTTPS location over a connection pinned to
 * `address`, keeping the hostname for TLS verification. Redirects are not
 * followed and the body is discarded.
 */
export const probeLocation: ProbeLocation = (locator, address, timeoutMs) =>
  new Promise((resolve, reject) => {
    const url = new URL(locator);
    if (url.protocol !== "https:") {
      reject(new Error("only https locations are probed"));
      return;
    }
    const probe = request(
      url,
      {
        method: "GET",
        headers: { range: "bytes=0-0", "accept-encoding": "identity" },
        lookup: pinnedLookup(address),
        timeout: timeoutMs,
      },
      (response) => {
        const headers = new Headers();
        for (const name of ["content-type", "content-range", "content-length"]) {
          const value = response.headers[name];
          if (value === undefined) continue;
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve({ status: response.statusCode ?? 0, headers });
        response.destroy();
      },
    );
    probe.on("timeout", () => probe.destroy(new Error("the probe timed out")));
    probe.on("error", reject);
    probe.end();
  });

const MEDIA_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/u;

/** The bare media type of a Content-Type header, or nothing; parameters are never shown. */
export function displayMediaType(header: string | null): string | undefined {
  const type = header?.split(";", 1)[0]?.trim().toLowerCase();
  return type !== undefined && MEDIA_TYPE_PATTERN.test(type) ? type : undefined;
}
