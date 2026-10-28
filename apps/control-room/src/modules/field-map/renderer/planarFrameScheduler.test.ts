import { describe, expect, it, vi } from "vitest";

import { createPlanarFrameScheduler } from "./planarFrameScheduler";

describe("planar frame scheduler", () => {
  it("coalesces invalidations and cancels a pending frame on dispose", () => {
    const callbacks: FrameRequestCallback[] = [];
    const host = {
      cancelAnimationFrame: vi.fn(),
      requestAnimationFrame: vi.fn((next: FrameRequestCallback) => {
        callbacks.push(next);
        return 17;
      }),
    };
    const render = vi.fn();
    const scheduler = createPlanarFrameScheduler(host, render);

    scheduler.invalidate();
    scheduler.invalidate();
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(1);
    callbacks[0]?.(0);
    expect(render).toHaveBeenCalledTimes(1);

    scheduler.invalidate();
    scheduler.dispose();
    expect(host.cancelAnimationFrame).toHaveBeenCalledWith(17);
  });
});

describe("coalesced frame publisher", () => {
  it("publishes only the latest value once per frame", async () => {
    const { createCoalescedFramePublisher } = await import("./planarFrameScheduler");
    const callbacks: FrameRequestCallback[] = [];
    const host = {
      cancelAnimationFrame: () => undefined,
      requestAnimationFrame: (callback: FrameRequestCallback) => callbacks.push(callback),
    };
    const published: number[] = [];
    const publisher = createCoalescedFramePublisher<number>(host, (value) => published.push(value));
    publisher.push(1);
    publisher.push(2);
    publisher.push(3);
    expect(callbacks).toHaveLength(1);
    callbacks[0]!(0);
    expect(published).toEqual([3]);
    publisher.dispose();
  });
});
