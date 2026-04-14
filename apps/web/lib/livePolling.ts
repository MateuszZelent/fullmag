export const LIVE_POLL_INTERVAL_STORAGE_KEY = "fullmag.live.poll_interval_ms";
export const LIVE_POLL_INTERVAL_DEFAULT_MS = 1000;
export const LIVE_POLL_INTERVAL_MIN_MS = 250;
export const LIVE_POLL_INTERVAL_MAX_MS = 5000;

export function clampLivePollIntervalMs(value: number): number {
  if (!Number.isFinite(value)) return LIVE_POLL_INTERVAL_DEFAULT_MS;
  return Math.min(
    LIVE_POLL_INTERVAL_MAX_MS,
    Math.max(LIVE_POLL_INTERVAL_MIN_MS, Math.round(value)),
  );
}

export function getLivePollIntervalMs(): number {
  if (typeof window === "undefined") return LIVE_POLL_INTERVAL_DEFAULT_MS;
  const raw = window.localStorage.getItem(LIVE_POLL_INTERVAL_STORAGE_KEY);
  if (!raw) return LIVE_POLL_INTERVAL_DEFAULT_MS;
  return clampLivePollIntervalMs(Number(raw));
}

export function setLivePollIntervalMs(value: number): number {
  const normalized = clampLivePollIntervalMs(value);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(
      LIVE_POLL_INTERVAL_STORAGE_KEY,
      String(normalized),
    );
    window.dispatchEvent(
      new CustomEvent("fullmag:live-poll-interval-changed", {
        detail: { pollIntervalMs: normalized },
      }),
    );
  }
  return normalized;
}
