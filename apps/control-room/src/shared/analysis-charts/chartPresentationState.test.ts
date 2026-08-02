import { describe, expect, it } from "vitest";

import { deriveChartPresentationState } from "./chartPresentationState";

const active = { latestKnownRevision: null, paused: false };
const points = [{ x: 1, y: 2 }];

function loading<T>(
  data: T | null,
  visibleRevision: string | number | null = null,
  requestedRevision: string | number | null = null,
) {
  return {
    data,
    error: null,
    requestedRevision,
    status: "loading" as const,
    visibleRevision,
  };
}

function failed<T>(
  data: T,
  visibleRevision: string | number,
  error: Error,
) {
  return {
    data,
    error,
    requestedRevision: visibleRevision,
    status: "error" as const,
    visibleRevision,
  };
}

describe("deriveChartPresentationState", () => {
  it("uses initial-loading only when no usable payload exists", () => {
    expect(deriveChartPresentationState(loading(null), active)).toEqual({
      kind: "initial-loading",
    });
  });

  it("reports refreshing while retaining the visible revision", () => {
    expect(
      deriveChartPresentationState(loading(points, "41", "42"), active),
    ).toEqual({
      kind: "refreshing",
      requestedRevision: "42",
      visibleRevision: "41",
    });
  });

  it("reports stale data with its refresh error", () => {
    const refreshError = new Error("connection lost");
    const state = deriveChartPresentationState(
      failed(points, "41", refreshError),
      active,
    );

    expect(state.kind).toBe("stale");
    expect(state).toMatchObject({
      error: refreshError,
      visibleRevision: "41",
    });
  });
});
