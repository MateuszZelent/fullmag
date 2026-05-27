import type { ResourceRevision } from "@/kernel/api/apiTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

export const VIEWPORT_3D_REFRESH_DEFAULT_INTERVAL_MS = 1_000;
export const VIEWPORT_3D_REFRESH_MIN_INTERVAL_MS = 200;
export const VIEWPORT_3D_REFRESH_MAX_INTERVAL_MS = 5_000;
export const VIEWPORT_3D_REFRESH_FLASH_MS = 650;

export interface Viewport3DFieldRefreshState {
  enabled: boolean;
  quantityId: string;
  resourceKey: string;
  revision: ResourceRevision | null;
  status: ResourceStatus;
}

export interface Viewport3DRefreshSample {
  flashUntilMs: number;
  intervalMs: number;
  pulseId: number;
  refreshedAtMs: number | null;
  revision: ResourceRevision | null;
}

export interface Viewport3DRefreshCountdownDisplay {
  ariaLabel: string;
  detail: string;
  progress: number;
  state: "counting" | "error" | "syncing" | "updated" | "waiting";
  title: string;
}

export const EMPTY_VIEWPORT_3D_REFRESH_SAMPLE: Viewport3DRefreshSample = {
  flashUntilMs: 0,
  intervalMs: VIEWPORT_3D_REFRESH_DEFAULT_INTERVAL_MS,
  pulseId: 0,
  refreshedAtMs: null,
  revision: null,
};

export function updateViewport3DRefreshSample(
  previous: Viewport3DRefreshSample,
  input: {
    nowMs: number;
    revision: ResourceRevision | null;
    status: ResourceStatus;
  },
): Viewport3DRefreshSample {
  if (input.status !== "ready" || input.revision === null) {
    return previous;
  }
  if (Object.is(previous.revision, input.revision)) {
    return previous;
  }

  const observedIntervalMs =
    previous.refreshedAtMs === null
      ? previous.intervalMs
      : input.nowMs - previous.refreshedAtMs;
  const intervalMs = resolveViewport3DRefreshInterval(
    previous.intervalMs,
    observedIntervalMs,
  );

  return {
    flashUntilMs: input.nowMs + VIEWPORT_3D_REFRESH_FLASH_MS,
    intervalMs,
    pulseId: previous.pulseId + 1,
    refreshedAtMs: input.nowMs,
    revision: input.revision,
  };
}

export function resolveViewport3DRefreshCountdownDisplay(input: {
  enabled: boolean;
  nowMs: number;
  sample: Viewport3DRefreshSample;
  status: ResourceStatus;
}): Viewport3DRefreshCountdownDisplay | null {
  if (!input.enabled || input.status === "idle") {
    return null;
  }

  if (input.status === "error") {
    return {
      ariaLabel: "Field refresh failed",
      detail: "error",
      progress: 0,
      state: "error",
      title: "Field sync",
    };
  }

  if (input.status === "loading" || input.status === "stale") {
    return {
      ariaLabel: "Field refresh in progress",
      detail: "syncing",
      progress: 1,
      state: "syncing",
      title: "Field sync",
    };
  }

  if (input.sample.refreshedAtMs === null || input.nowMs <= 0) {
    return {
      ariaLabel: "Waiting for field refresh",
      detail: "waiting",
      progress: 0,
      state: "waiting",
      title: "Field sync",
    };
  }

  if (input.nowMs < input.sample.flashUntilMs) {
    return {
      ariaLabel: "Field refreshed",
      detail: "updated",
      progress: 1,
      state: "updated",
      title: "Field sync",
    };
  }

  const elapsedMs = Math.max(0, input.nowMs - input.sample.refreshedAtMs);
  const remainingMs = Math.max(0, input.sample.intervalMs - elapsedMs);
  if (remainingMs <= 0) {
    return {
      ariaLabel: "Waiting for next field refresh",
      detail: "waiting",
      progress: 1,
      state: "waiting",
      title: "Next field sync",
    };
  }

  const progress = clamp01(elapsedMs / input.sample.intervalMs);
  return {
    ariaLabel: `Next field refresh in ${formatViewport3DRefreshRemaining(remainingMs)}`,
    detail: formatViewport3DRefreshRemaining(remainingMs),
    progress,
    state: "counting",
    title: "Next field sync",
  };
}

export function formatViewport3DRefreshRemaining(ms: number): string {
  const seconds = Math.max(0, ms) / 1_000;
  if (seconds >= 10) return `${Math.ceil(seconds)}s`;
  return `${seconds.toFixed(1)}s`;
}

function resolveViewport3DRefreshInterval(
  previousIntervalMs: number,
  observedIntervalMs: number,
): number {
  const observed = clamp(
    observedIntervalMs,
    VIEWPORT_3D_REFRESH_MIN_INTERVAL_MS,
    VIEWPORT_3D_REFRESH_MAX_INTERVAL_MS,
  );
  const previous = clamp(
    previousIntervalMs,
    VIEWPORT_3D_REFRESH_MIN_INTERVAL_MS,
    VIEWPORT_3D_REFRESH_MAX_INTERVAL_MS,
  );
  return Math.round(previous * 0.35 + observed * 0.65);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
