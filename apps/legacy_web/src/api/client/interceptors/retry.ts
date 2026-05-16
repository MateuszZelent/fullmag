/**
 * Retry interceptor.
 * Retries on 5xx status codes with exponential backoff.
 * No retry on 4xx (client errors).
 */

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 200,
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry(
  doFetch: () => Promise<Response>,
  config: Partial<RetryConfig> = {},
  signal?: AbortSignal,
): Promise<Response> {
  const { maxRetries, baseDelayMs } = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastResponse: Response | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await doFetch();

    if (response.status < 500) {
      return response;
    }

    lastResponse = response;

    if (attempt < maxRetries) {
      const delayMs = baseDelayMs * Math.pow(2, attempt);
      await sleep(delayMs, signal);
    }
  }

  return lastResponse!;
}
