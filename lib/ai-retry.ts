import "server-only";

/**
 * Model calls in the ad flow (the check, the leftover-mark check, the edit
 * summary) can stall: the request is sent and nothing ever comes back. With
 * no limit, the step waits until Vercel kills its function (300s), and the ad
 * sits "generating" until the 10-minute sweep fails it.
 *
 * Each attempt gets STALL_TIMEOUT_MS; a timed-out or failed attempt is tried
 * again, at most STALL_RETRIES more times. A check normally answers in 5–12
 * seconds, so a 45-second wait means it's stuck, not slow. Worst case
 * (3 × 45s) stays well inside one step's time.
 */
export const STALL_TIMEOUT_MS = Number(process.env.STALL_TIMEOUT_MS) || 45_000;
export const STALL_RETRIES = 2;

/** Every attempt timed out: the model never answered. */
export class ModelStalledError extends Error {
  constructor(what: string, attempts: number) {
    super(`${what} didn't respond after ${attempts} ${attempts === 1 ? "try" : "tries"}`);
    this.name = "ModelStalledError";
  }
}

/**
 * Runs `call` with a fresh timeout signal per attempt (pass it to the AI
 * SDK's `abortSignal`, with `maxRetries: 0` so the SDK doesn't retry inside
 * an attempt). Throws ModelStalledError when every attempt timed out, or the
 * last error otherwise.
 */
export async function withStallRetry<T>(what: string, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let lastError: unknown;
  let allTimedOut = true;
  const attempts = STALL_RETRIES + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call(AbortSignal.timeout(STALL_TIMEOUT_MS));
    } catch (error) {
      lastError = error;
      const timedOut = isTimeout(error);
      if (!timedOut) allTimedOut = false;
      console.warn(`[ai] ${what}: attempt ${attempt} of ${attempts} ${timedOut ? "timed out" : "failed"}`);
    }
  }
  throw allTimedOut ? new ModelStalledError(what, attempts) : lastError;
}

function isTimeout(error: unknown): boolean {
  for (let e = error as { name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  }
  return false;
}
