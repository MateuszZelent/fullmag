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
