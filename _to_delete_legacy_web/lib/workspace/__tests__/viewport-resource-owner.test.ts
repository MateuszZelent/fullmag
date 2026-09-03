import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/debug/viewportResourceManager", () => ({
  releaseViewportResourcesByOwner: vi.fn(),
}));

import { releaseViewportResourcesByOwner } from "@/lib/debug/viewportResourceManager";
import {
  disposeViewportResourceOwner,
  disposeViewportResourceOwnersByPrefix,
  getViewportResourceOwner,
  getViewportResourceOwnerSnapshot,
  workspaceViewportResourceOwnerId,
} from "../viewport-resource-owner";

describe("ViewportResourceOwner", () => {
  beforeEach(() => {
    disposeViewportResourceOwnersByPrefix("", "test-reset");
    vi.clearAllMocks();
  });

  it("runs registered cleanup once on dispose", () => {
    const cleanup = vi.fn();
    const owner = getViewportResourceOwner("workspace:study:core:3d");
    owner.registerCleanup("geometry", cleanup);

    disposeViewportResourceOwner(owner.ownerId, "tab-close");
    disposeViewportResourceOwner(owner.ownerId, "tab-close");

    expect(cleanup).toHaveBeenCalledOnce();
    expect(releaseViewportResourcesByOwner).toHaveBeenCalledWith(owner.ownerId);
  });

  it("aborts active AbortControllers on dispose", () => {
    const owner = getViewportResourceOwner("workspace:study:core:2d");
    const signal = owner.createAbortController("field-vector");

    expect(signal.aborted).toBe(false);
    disposeViewportResourceOwner(owner.ownerId, "tab-hide");

    expect(signal.aborted).toBe(true);
  });

  it("replacing cleanup under the same key runs the previous cleanup", () => {
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    const owner = getViewportResourceOwner("workspace:study:result:m");

    owner.registerCleanup("resource", firstCleanup);
    owner.registerCleanup("resource", secondCleanup);

    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(secondCleanup).not.toHaveBeenCalled();

    disposeViewportResourceOwner(owner.ownerId, "tab-close");
    expect(secondCleanup).toHaveBeenCalledOnce();
  });

  it("unregisters only the matching cleanup for a key", () => {
    const firstCleanup = vi.fn();
    const secondCleanup = vi.fn();
    const owner = getViewportResourceOwner("workspace:study:result:2d");

    owner.registerCleanup("worker", firstCleanup);
    owner.unregisterCleanup("worker", secondCleanup);
    expect(getViewportResourceOwnerSnapshot()[0]?.cleanupCount).toBe(1);

    owner.unregisterCleanup("worker", firstCleanup);
    expect(getViewportResourceOwnerSnapshot()[0]?.cleanupCount).toBe(0);
    disposeViewportResourceOwner(owner.ownerId, "tab-close");

    expect(firstCleanup).not.toHaveBeenCalled();
    expect(secondCleanup).not.toHaveBeenCalled();
  });

  it("snapshot shows active owners and removes them after dispose", () => {
    const ownerId = workspaceViewportResourceOwnerId("study", "core:3d");
    const owner = getViewportResourceOwner(ownerId);
    owner.createAbortController("request");
    owner.registerCleanup("cleanup", vi.fn());

    expect(getViewportResourceOwnerSnapshot()).toEqual([
      {
        ownerId,
        abortControllers: 1,
        cleanupCount: 1,
        disposed: false,
      },
    ]);

    disposeViewportResourceOwner(ownerId, "tab-close");
    expect(getViewportResourceOwnerSnapshot()).toEqual([]);
  });
});
