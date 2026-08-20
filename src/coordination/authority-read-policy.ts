/**
 * Authority reads are inspection boundaries: retry only failures that are
 * plausibly transient, and never retry a successful read proving that
 * ownership is absent, stale, or foreign.
 */
export function isTransientAuthorityReadFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  const status = Number(value.status ?? value.statusCode);
  if (Number.isInteger(status) && (status === 408 || status === 429 || status >= 500)) return true;
  const text = [value.message, value.code, value.stderr, value.stdout, value.cause]
    .filter((part) => part !== undefined)
    .map(String)
    .join(" ")
    .toLowerCase();
  return /econn|eai_|enotfound|enetwork|etimedout|epipe|network|timeout|timed out|temporar|unavailable|connection|socket|fetch failed|rate limit|too many requests|\b(?:502|503|504)\b/.test(text);
}

export const DEFAULT_AUTHORITY_READ_ATTEMPTS = 3;

export async function readAuthorityWithTransientRetry<T>(
  read: () => Promise<T>,
  maxAttempts = DEFAULT_AUTHORITY_READ_ATTEMPTS,
): Promise<T> {
  const budget = Math.max(1, Math.trunc(maxAttempts));
  let attempts = 0;
  while (attempts < budget) {
    attempts += 1;
    try {
      return await read();
    } catch (error) {
      if (!isTransientAuthorityReadFailure(error) || attempts >= budget) throw error;
    }
  }
  throw new Error("authority read exhausted without a result");
}
