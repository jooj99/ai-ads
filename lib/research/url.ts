/** Thrown for input the user can fix, so the message is safe to show them. */
export class ResearchInputError extends Error {}

const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
];

/**
 * Blocks hosts that would make our server fetch its own network (SSRF):
 * localhost, internal names and private IP literals. Public DNS names that
 * resolve privately are not caught here; Firecrawl does the heavy fetching
 * from its own infrastructure, and our direct fetches are read-only GETs.
 */
function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host.startsWith("[")) return true; // IPv6 literals
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return PRIVATE_IPV4.some((range) => range.test(host));
  }
  return false;
}

/** True for public https/http URLs; used before fetching URLs found inside pages. */
export function isPublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname.includes(".") &&
      !isPrivateHost(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/** Accepts "loopycases.com", "www.loopycases.com/..." or a full URL. */
export function normalizeStoreUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new ResearchInputError("Enter your store's URL.");

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ResearchInputError(`"${trimmed}" doesn't look like a web address.`);
  }

  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || isPrivateHost(host)) {
    throw new ResearchInputError("Enter a public website address, like loopycases.com.");
  }

  url.hash = "";
  return url;
}

/** Resolves relative and protocol-relative asset URLs against the page. */
export function absoluteUrl(value: string | null | undefined, base: string): string | undefined {
  if (!value || value.startsWith("data:")) return undefined;
  try {
    // Values read from HTML attributes still carry entity-escaped ampersands.
    const url = new URL(value.replace(/&amp;/g, "&"), base);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}
