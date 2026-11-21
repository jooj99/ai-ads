import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { isPrivateIPv4, isPublicHttpUrl } from "./url";

/**
 * `fetch` for URLs found on the web (a site's pages, stylesheets, logo,
 * fonts, product photos). `isPublicHttpUrl` only reads the URL text, so
 * on its own a public address could still reach our own network: by
 * redirecting to one (`Location: http://127.0.0.1/…`), or by a DNS name
 * that resolves to one. Here every hop is checked before it's fetched: the
 * URL, then the addresses its host resolves to. Redirects are followed by
 * hand (up to five), each one checked the same way.
 *
 * Throws `BlockedUrlError` for a private target; callers already treat a
 * failed fetch as "couldn't load it". The final response's `url` is the
 * last hop, as with an ordinary fetch.
 */

const MAX_REDIRECTS = 5;

export class BlockedUrlError extends Error {
  constructor(url: string) {
    super(`not a public address: ${url.slice(0, 120)}`);
    this.name = "BlockedUrlError";
  }
}

export async function publicFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  let url = new URL(input);
  for (let hop = 0; ; hop++) {
    await assertPublic(url);
    const res = await fetch(url, { ...init, redirect: "manual" });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return res;
    void res.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects from ${new URL(input).href.slice(0, 120)}`);
    url = new URL(location, url);
  }
}

async function assertPublic(url: URL): Promise<void> {
  if (!isPublicHttpUrl(url.href)) throw new BlockedUrlError(url.href);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new BlockedUrlError(url.href);
}

/** Loopback, private, link-local, unique-local or unspecified, in IPv4 or IPv6. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return (
    v6 === "::" ||
    v6 === "::1" ||
    /^f[cd]/.test(v6) || // unique local fc00::/7
    /^fe[89ab]/.test(v6) || // link-local fe80::/10
    v6.startsWith("::ffff:") // other mapped forms (hex), treated as private
  );
}
