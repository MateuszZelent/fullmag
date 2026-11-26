import type { ResourceRevision } from "@/kernel/api/apiTypes";
import type { ResourceStatus } from "@/kernel/resources/resourceTypes";

const VIEWPORT_3D_REFRESH_DEFAULT_INTERVAL_MS = 1_000;
const VIEWPORT_3D_REFRESH_MIN_INTERVAL_MS = 200;
const VIEWPORT_3D_REFRESH_MAX_INTERVAL_MS = 5_000;
const VIEWPORT_3D_REFRESH_FLASH_MS = 650;
const VIEWPORT_3D_REFRESH_TIMER_MIN_DELAY_MS = 250;

export interface Viewport3DFieldRefreshState {
  enabled: boolean;
  payloadRevision?: ResourceRevision | null;
  quantityId: string;
  resourceKey: string;
  revision: ResourceRevision | null;
  requestedRevision?: ResourceRevision | null;
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
  state: "error" | "syncing" | "updated" | "waiting";
  title: string;
}

export function resolveViewport3DRefreshCountdownNextTickDelay(input: {
  enabled: boolean;
  nowMs: number;
  sample: Viewport3DRefreshSample;
  status: ResourceStatus;
}): number | null {
  if (!input.enabled || input.status === "idle" || input.status === "error") {
    return null;
  }
  if (input.status === "loading" || input.status === "stale") {
    return null;
  }
  if (input.sample.refreshedAtMs === null || input.nowMs <= 0) {
    return null;
  }

  if (input.nowMs < input.sample.flashUntilMs) {
    return clampTickDelay(input.sample.flashUntilMs - input.nowMs);
  }
  if (input.sample.pulseId < 2) {
    return null;
  }

  const elapsedMs = Math.max(0, input.nowMs - input.sample.refreshedAtMs);
  const remainingMs = Math.max(0, input.sample.intervalMs - elapsedMs);
  if (remainingMs <= 0) {
    return null;
  }
  return Math.max(
    VIEWPORT_3D_REFRESH_TIMER_MIN_DELAY_MS,
    Math.ceil(remainingMs),
  );
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
  payloadRevision?: ResourceRevision | null;
  requestedRevision?: ResourceRevision | null;
  sample: Viewport3DRefreshSample;
  status: ResourceStatus;
}): Viewport3DRefreshCountdownDisplay | null {
  if (!input.enabled || input.status === "idle") {
    return null;
  }

  if (input.status === "error") {
    return {
      ariaLabel: "Field refresh failed",
      detail: "Refresh failed",
      state: "error",
      title: "Field refresh failed",
    };
  }

  if (input.status === "loading" || input.status === "stale") {
    return {
      ariaLabel: "Updating field data",
      detail: "Updating",
      state: "syncing",
      title: "Field update in progress",
    };
  }

  if (input.sample.refreshedAtMs === null || input.nowMs <= 0) {
    return null;
  }

  if (input.nowMs < input.sample.flashUntilMs) {
    return {
      ariaLabel: "Field data updated",
      detail: "Updated",
      state: "updated",
      title: "Field data updated",
    };
  }

  if (input.sample.pulseId < 2) {
    return null;
  }

  const elapsedMs = Math.max(0, input.nowMs - input.sample.refreshedAtMs);
  const remainingMs = Math.max(0, input.sample.intervalMs - elapsedMs);
  if (remainingMs <= 0) {
    return {
      ariaLabel: "No new field data received",
      detail: "No new data",
      state: "waiting",
      title: "Field data delayed",
    };
  }

  // The ordinary viewport stays quiet until the expected refresh is late.
  // Exact revisions remain available in the Render details diagnostics.
  return null;
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

function clampTickDelay(value: number): number {
  return Math.max(
    VIEWPORT_3D_REFRESH_TIMER_MIN_DELAY_MS,
    Math.ceil(value),
  );
}
