import { describe, expect, it } from "vitest";

import {
  resolveViewModeSyncFromWorkspaceTab,
  resolveViewModeSyncFromWorkspaceTabChange,
  workspaceTabViewSyncKey,
} from "../controlRoomContextHelpers";
import { resolveControlRoomStartupState } from "../controlRoomShellHelpers";

describe("resolveViewModeSyncFromWorkspaceTab", () => {
  it("does not collapse Mesh back to 3D when core:3d stays active", () => {
    expect(
      resolveViewModeSyncFromWorkspaceTab({
        activeTabId: "core:3d",
        payloadViewMode: "3D",
        currentViewMode: "Mesh",
      }),
    ).toBeNull();
  });

  it("syncs to 3D when core:3d becomes active from a different mode", () => {
    expect(
      resolveViewModeSyncFromWorkspaceTab({
        activeTabId: "core:3d",
        payloadViewMode: "3D",
        currentViewMode: "Analyze",
      }),
    ).toBe("3D");
  });

  it("syncs unique core tabs to their owning modes", () => {
    expect(
      resolveViewModeSyncFromWorkspaceTab({
        activeTabId: "core:2d",
        payloadViewMode: "2D",
        currentViewMode: "3D",
      }),
    ).toBe("2D");
    expect(
      resolveViewModeSyncFromWorkspaceTab({
        activeTabId: "core:analyze",
        payloadViewMode: "Analyze",
        currentViewMode: "3D",
      }),
    ).toBe("Analyze");
  });

  it("does not infer a mode from core tab ids alone when payload viewMode is missing", () => {
    expect(
      resolveViewModeSyncFromWorkspaceTab({
        activeTabId: "core:2d",
        payloadViewMode: null,
        currentViewMode: "3D",
      }),
    ).toBeNull();
    expect(
      resolveViewModeSyncFromWorkspaceTab({
        activeTabId: "core:3d",
        payloadViewMode: null,
        currentViewMode: "Analyze",
      }),
    ).toBeNull();
  });
});

describe("resolveViewModeSyncFromWorkspaceTabChange", () => {
  it("syncs the first time a core tab becomes active", () => {
    expect(
      resolveViewModeSyncFromWorkspaceTabChange({
        previousSyncKey: null,
        activeTabId: "core:2d",
        payloadViewMode: "2D",
        currentViewMode: "3D",
      }),
    ).toEqual({
      nextMode: "2D",
      nextSyncKey: "core:2d:2D",
      consumedInternalSyncKey: false,
    });
  });

  it("does not resync when the same workspace tab key is replayed", () => {
    expect(
      resolveViewModeSyncFromWorkspaceTabChange({
        previousSyncKey: "core:2d:2D",
        activeTabId: "core:2d",
        payloadViewMode: "2D",
        currentViewMode: "3D",
      }),
    ).toEqual({
      nextMode: null,
      nextSyncKey: "core:2d:2D",
      consumedInternalSyncKey: false,
    });
  });

  it("resyncs when the active core tab actually changes", () => {
    expect(
      resolveViewModeSyncFromWorkspaceTabChange({
        previousSyncKey: "core:3d:3D",
        activeTabId: "core:analyze",
        payloadViewMode: "Analyze",
        currentViewMode: "3D",
      }),
    ).toEqual({
      nextMode: "Analyze",
      nextSyncKey: "core:analyze:Analyze",
      consumedInternalSyncKey: false,
    });
  });

  it("treats internal view transitions as already synchronized instead of recovery", () => {
    const pendingInternalSyncKey = workspaceTabViewSyncKey({
      activeTabId: "core:2d",
      payloadViewMode: "2D",
    });
    expect(
      resolveViewModeSyncFromWorkspaceTabChange({
        previousSyncKey: "core:3d:3D",
        pendingInternalSyncKey,
        activeTabId: "core:2d",
        payloadViewMode: "2D",
        currentViewMode: "3D",
      }),
    ).toEqual({
      nextMode: null,
      nextSyncKey: "core:2d:2D",
      consumedInternalSyncKey: true,
    });
  });
});

describe("resolveControlRoomStartupState", () => {
  it("keeps no-active-workspace as the only hard startup screen", () => {
    expect(
      resolveControlRoomStartupState({
        hasSession: false,
        error: "no active local live workspace",
      }),
    ).toBe("no-active-workspace");
  });

  it("treats missing session without that sentinel error as initializing", () => {
    expect(
      resolveControlRoomStartupState({
        hasSession: false,
        error: null,
      }),
    ).toBe("initializing");
    expect(
      resolveControlRoomStartupState({
        hasSession: false,
        error: "temporary transport failure",
      }),
    ).toBe("initializing");
  });

  it("marks the shell ready as soon as a session exists", () => {
    expect(
      resolveControlRoomStartupState({
        hasSession: true,
        error: null,
      }),
    ).toBe("ready");
  });
});
