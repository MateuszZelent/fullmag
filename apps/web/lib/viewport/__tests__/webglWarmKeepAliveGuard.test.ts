import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disableWebGLWarmKeepAliveForSession,
  isWebGLWarmKeepAliveDisabledForSession,
  resetWebGLWarmKeepAliveGuardForTests,
  subscribeWebGLWarmKeepAliveGuard,
} from "../webglWarmKeepAliveGuard";

describe("webglWarmKeepAliveGuard", () => {
  afterEach(() => {
    resetWebGLWarmKeepAliveGuardForTests();
  });

  it("disables warm keepalive once per session and notifies listeners", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWebGLWarmKeepAliveGuard(listener);

    expect(isWebGLWarmKeepAliveDisabledForSession()).toBe(false);

    disableWebGLWarmKeepAliveForSession();
    disableWebGLWarmKeepAliveForSession();

    expect(isWebGLWarmKeepAliveDisabledForSession()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
