/**
 * Analyze feature – API client.
 *
 * Wraps artifact fetching with abort-on-unmount, request dedup,
 * and error normalization per master plan Section 10.4.
 */
import type { AnalyzeQueryKey, AnalyzeQueryState } from "../model/analyzeTypes";
import { useAnalyzeStore } from "../store/useAnalyzeStore";

const inflight = new Map<string, AbortController>();

function keyString(key: AnalyzeQueryKey): string {
  return JSON.stringify(key);
}

/**
 * Fetch an analyze artifact with automatic dedup and abort.
 * Returns the resolved data or throws on error.
 */
export async function fetchAnalyzeArtifact<T>(
  key: AnalyzeQueryKey,
  fetcher: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const k = keyString(key);
  const store = useAnalyzeStore.getState();

  // Abort any in-flight request for the same key
  const existing = inflight.get(k);
  if (existing) {
    existing.abort();
  }

  const controller = new AbortController();
  inflight.set(k, controller);

  store.setQuery(key, {
    status: "loading",
    error: null,
    requestedAt: Date.now(),
  });

  try {
    const data = await fetcher(controller.signal);

    if (!controller.signal.aborted) {
      store.setQuery(key, {
        status: "success",
        data,
        error: null,
        completedAt: Date.now(),
      });
    }

    return data;
  } catch (err: unknown) {
    if (controller.signal.aborted) {
      throw err; // Caller decided to abort — do not overwrite state
    }

    const message =
      err instanceof Error ? err.message : "Unknown analyze fetch error";

    store.setQuery(key, {
      status: "error",
      data: null,
      error: message,
      completedAt: Date.now(),
    });

    throw err;
  } finally {
    if (inflight.get(k) === controller) {
      inflight.delete(k);
    }
  }
}

/**
 * Abort all in-flight analyze requests. Call on unmount of the analyze view.
 */
export function abortAllAnalyzeRequests(): void {
  for (const controller of inflight.values()) {
    controller.abort();
  }
  inflight.clear();
}
