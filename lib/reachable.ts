import "server-only";

/**
 * Local dev runs Supabase on this machine, so its signed Storage URLs point
 * at 127.0.0.1, which fal's and Anthropic's servers can't fetch. These
 * helpers hand outside services something they can reach instead: in
 * production (a public Supabase URL) every URL passes through unchanged.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0", "host.docker.internal"]);

/** Whether a URL points at this machine (local Supabase, the dev server). */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return LOCAL_HOSTS.has(host) || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** A local URL's bytes and type (we can fetch it; outside services can't). */
export async function fetchLocal(url: string): Promise<{ bytes: Uint8Array; type: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`reading a local image failed (${res.status})`);
  return { bytes: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "image/png" };
}

/** A local URL as an inline `data:` URL (for model messages); others unchanged. */
export async function inlineIfLocal(url: string): Promise<string> {
  if (!isLocalUrl(url)) return url;
  const { bytes, type } = await fetchLocal(url);
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
}
