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
/** Individual authority subprocesses must not hold the scheduler forever. */
export const DEFAULT_AUTHORITY_OPERATION_TIMEOUT_MS = 15_000;

export class AuthorityOperationTimeoutError extends Error {
  readonly code = "authority_operation_timeout";

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`Authority operation timed out after ${timeoutMs}ms: ${operation}`);
    this.name = "AuthorityOperationTimeoutError";
  }
}

/**
 * Bounds adapter calls too, including injected authorities used by hosts and
 * tests. Production subprocesses also receive a child-process timeout so the
 * underlying `gh` process is terminated rather than merely abandoned.
 */
export async function withAuthorityTimeout<T>(
  operation: string,
  work: Promise<T>,
  timeoutMs = DEFAULT_AUTHORITY_OPERATION_TIMEOUT_MS,
): Promise<T> {
  const bounded = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : DEFAULT_AUTHORITY_OPERATION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new AuthorityOperationTimeoutError(operation, bounded)), bounded);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function authorityOperationTimeoutMs(): number {
  const configured = Number.parseInt(process.env.PI_NEXT_AUTHORITY_TIMEOUT_MS || "", 10);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_AUTHORITY_OPERATION_TIMEOUT_MS;
}

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
