import { describe, expect, it, vi } from "vitest";

import { applyLiveBufferTransition, shouldAnimateLiveBuffer } from "../liveBufferAnimation";

describe("liveBufferAnimation", () => {
  it("copies immediately when reduced motion is enabled", () => {
    const destination = new Float32Array([0, 0, 0]);
    const target = new Float32Array([1, 2, 3]);
    const markNeedsUpdate = vi.fn();
    const scheduleInvalidate = vi.fn();

    applyLiveBufferTransition({
      destination,
      target,
      reducedMotion: true,
      markNeedsUpdate,
      scheduleInvalidate,
    });

    expect(Array.from(destination)).toEqual([1, 2, 3]);
    expect(markNeedsUpdate).toHaveBeenCalledTimes(1);
    expect(scheduleInvalidate).toHaveBeenCalledTimes(1);
  });

  it("interpolates live buffers over the requested duration", () => {
    const destination = new Float32Array([0, 10]);
    const target = new Float32Array([10, 20]);
    const frames: FrameRequestCallback[] = [];
    const markNeedsUpdate = vi.fn();
    const scheduleInvalidate = vi.fn();

    applyLiveBufferTransition({
      destination,
      target,
      durationMs: 100,
      reducedMotion: false,
      now: () => 0,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      markNeedsUpdate,
      scheduleInvalidate,
    });

    expect(Array.from(destination)).toEqual([0, 10]);
    frames.shift()?.(50);
    expect(Array.from(destination)).toEqual([5, 15]);
    frames.shift()?.(100);
    expect(Array.from(destination)).toEqual([10, 20]);
    expect(markNeedsUpdate).toHaveBeenCalledTimes(2);
    expect(scheduleInvalidate).toHaveBeenCalledTimes(2);
  });

  it("does not clone the target buffer for animated transitions", () => {
    const destination = new Float32Array([0, 10]);
    const target = new Float32Array([10, 20]);
    const originalSlice = target.slice.bind(target);
    target.slice = (() => {
      throw new Error("target buffer should not be cloned");
    }) as typeof target.slice;
    const frames: FrameRequestCallback[] = [];

    applyLiveBufferTransition({
      destination,
      target,
      durationMs: 100,
      reducedMotion: false,
      now: () => 0,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      markNeedsUpdate: vi.fn(),
      scheduleInvalidate: vi.fn(),
    });

    target.slice = originalSlice;
    frames.shift()?.(100);
    expect(Array.from(destination)).toEqual([10, 20]);
  });

  it("can finish the target buffer when an interrupted transition is superseded", () => {
    const destination = new Float32Array([0, 0]);
    const target = new Float32Array([10, 20]);
    const frames: FrameRequestCallback[] = [];
    const markNeedsUpdate = vi.fn();
    const scheduleInvalidate = vi.fn();
    const cancelFrame = vi.fn();

    const cleanup = applyLiveBufferTransition({
      destination,
      target,
      durationMs: 100,
      reducedMotion: false,
      now: () => 0,
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame,
      markNeedsUpdate,
      scheduleInvalidate,
    });

    frames.shift()?.(25);
    expect(Array.from(destination)).not.toEqual([10, 20]);
    cleanup(true);
    expect(Array.from(destination)).toEqual([10, 20]);
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(markNeedsUpdate).toHaveBeenCalledTimes(2);
    expect(scheduleInvalidate).toHaveBeenCalledTimes(2);
  });

  it("respects the animation value budget", () => {
    expect(shouldAnimateLiveBuffer({ length: 8, maxAnimatedValues: 8 })).toBe(true);
    expect(shouldAnimateLiveBuffer({ length: 9, maxAnimatedValues: 8 })).toBe(false);
  });
});
