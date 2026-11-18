import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleViewport3DCameraRestCommit, VIEWPORT_3D_CAMERA_CONTROLS_COMMIT_DELAY_MS } from "./viewport3DCameraRestCommit";
afterEach(() => vi.useRealTimers());

describe("camera rest commit on slow frames", () => {
  it.each([250, 330])("coalesces wheel impulses %i ms apart into one final live pose", (interval) => {
    vi.useFakeTimers();
    const commit = vi.fn();
    let cancel = () => {};
    let epoch = 0;
    let livePose = { position: [0, 0, 1], orthographicScale: 1 };
    for (let index = 0; index < 5; index += 1) {
      cancel();
      const currentEpoch = ++epoch;
      livePose = { position: [0, 0, 1 + index], orthographicScale: 1 / (index + 1) };
      cancel = scheduleViewport3DCameraRestCommit({
        delayMs: VIEWPORT_3D_CAMERA_CONTROLS_COMMIT_DELAY_MS,
        isCurrent: () => epoch === currentEpoch,
        isMoving: () => false,
        requestFrame: vi.fn(),
        commit: () => commit(livePose),
      });
      if (index < 4) {
        vi.advanceTimersByTime(interval);
        expect(commit).not.toHaveBeenCalled();
      }
    }
    vi.advanceTimersByTime(499);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledExactlyOnceWith({ position: [0, 0, 5], orthographicScale: 0.2 });
    vi.advanceTimersByTime(1000);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("commits a single impulse only after its quiet period and observed rest", () => {
    vi.useFakeTimers();
    let moving = true;
    let liveScale = 1;
    const requestFrame = vi.fn(), commit = vi.fn();
    scheduleViewport3DCameraRestCommit({
      delayMs: VIEWPORT_3D_CAMERA_CONTROLS_COMMIT_DELAY_MS,
      isCurrent: () => true,
      isMoving: () => moving,
      requestFrame,
      commit: () => commit(liveScale),
    });
    vi.advanceTimersByTime(500);
    expect(commit).not.toHaveBeenCalled();
    expect(requestFrame).toHaveBeenCalledOnce();
    moving = false;
    liveScale = 0.75;
    vi.advanceTimersByTime(499);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledExactlyOnceWith(0.75);
  });
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
