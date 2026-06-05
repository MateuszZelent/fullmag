import { describe, expect, it } from "vitest";

import { createChartFrameScheduler } from "./chartFrameScheduler";

describe("createChartFrameScheduler", () => {
  it("coalesces repeated chart updates into one frame using the latest task", () => {
    let nextFrameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const calls: string[] = [];
    const scheduler = createChartFrameScheduler({
      cancelFrame: (id) => {
        frames.delete(Number(id));
      },
      requestFrame: (callback) => {
        nextFrameId += 1;
        frames.set(nextFrameId, callback);
        return nextFrameId;
      },
    });

    scheduler.schedule(() => calls.push("first"));
    scheduler.schedule(() => calls.push("second"));
    scheduler.schedule(() => calls.push("third"));

    expect(frames.size).toBe(1);
    const frame = frames.get(1);
    frames.delete(1);
    frame?.(16);

    expect(calls).toEqual(["third"]);
    expect(frames.size).toBe(0);
  });

  it("cancels pending chart work without running it", () => {
    let nextFrameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const calls: string[] = [];
    const scheduler = createChartFrameScheduler({
      cancelFrame: (id) => {
        frames.delete(Number(id));
      },
      requestFrame: (callback) => {
        nextFrameId += 1;
        frames.set(nextFrameId, callback);
        return nextFrameId;
      },
    });

    scheduler.schedule(() => calls.push("pending"));
    scheduler.cancel();
    const frame = frames.get(1);
    frames.delete(1);
    frame?.(16);

    expect(calls).toEqual([]);
    expect(frames.size).toBe(0);
  });
});
