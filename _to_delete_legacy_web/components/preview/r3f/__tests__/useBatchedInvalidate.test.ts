import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cancelBatchedViewportInvalidate,
  scheduleBatchedViewportInvalidate,
} from "../useBatchedInvalidate";

describe("scheduleBatchedViewportInvalidate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deduplicates invalidates into one animation frame", () => {
    const callbacks: FrameRequestCallback[] = [];
    const invalidate = vi.fn();
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancelAnimationFrame: vi.fn(),
    });

    scheduleBatchedViewportInvalidate(invalidate);
    scheduleBatchedViewportInvalidate(invalidate);

    expect(callbacks).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();

    callbacks[0](16);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("cancels an orphaned pending invalidate", () => {
    const callbacks: FrameRequestCallback[] = [];
    const cancelAnimationFrame = vi.fn();
    const invalidate = vi.fn();
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return 7;
      },
      cancelAnimationFrame,
    });

    scheduleBatchedViewportInvalidate(invalidate);
    cancelBatchedViewportInvalidate(invalidate);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
    callbacks[0](16);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
