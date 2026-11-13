import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleViewport3DCameraRestCommit } from "./viewport3DCameraRestCommit";
afterEach(() => vi.useRealTimers());

describe("camera rest commit on slow frames", () => {
  it("does not commit during an inter-frame gap, then commits once after observed rest", () => {
    vi.useFakeTimers();
    let moving = true;
    const requestFrame = vi.fn(), commit = vi.fn();
    scheduleViewport3DCameraRestCommit({ delayMs: 180, isCurrent: () => true,
      isMoving: () => moving, requestFrame, commit });
    vi.advanceTimersByTime(600);
    expect(commit).not.toHaveBeenCalled();
    expect(requestFrame).toHaveBeenCalledTimes(3);
    moving = false; // A real controls update, not elapsed wall time, observed rest.
    vi.advanceTimersByTime(120);
    expect(commit).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(commit).toHaveBeenCalledOnce();
    expect(requestFrame).toHaveBeenCalledTimes(3);
  });
  it("does not publish a stale gesture or keep requesting its frames", () => {
    vi.useFakeTimers();
    let epoch = 1;
    const requestFrame = vi.fn(), commit = vi.fn();
    scheduleViewport3DCameraRestCommit({ delayMs: 180, isCurrent: () => epoch === 1,
      isMoving: () => true, requestFrame, commit });
    epoch = 2;
    vi.advanceTimersByTime(1000);
    expect(commit).not.toHaveBeenCalled();
    expect(requestFrame).not.toHaveBeenCalled();
  });
  it("cancels pending work on teardown", () => {
    vi.useFakeTimers();
    const requestFrame = vi.fn(), commit = vi.fn();
    const cancel = scheduleViewport3DCameraRestCommit({ delayMs: 180, isCurrent: () => true,
      isMoving: () => true, requestFrame, commit });
    vi.advanceTimersByTime(180);
    cancel();
    vi.advanceTimersByTime(1000);
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });
});
