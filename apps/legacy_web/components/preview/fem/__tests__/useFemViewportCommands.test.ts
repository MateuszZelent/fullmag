import { describe, expect, it, vi } from "vitest";

import {
  applyToolbarColorFieldCommand,
  applyToolbarOpacityCommand,
  applyToolbarRenderModeCommand,
  setClipEnabledCommand,
  toggleClipCommand,
} from "../useFemViewportCommands";

describe("viewport command helpers", () => {
  it("changes draw mode without resetting unrelated viewport state", () => {
    const onRenderModeChange = vi.fn();
    const setInternalRenderMode = vi.fn();
    const setOpenPopover = vi.fn();

    applyToolbarRenderModeCommand(
      {
        hasMeshParts: false,
        toolbarStylePartIds: [],
        selectionScope: { kind: "universe" },
        onRenderModeChange,
        setInternalRenderMode,
        setOpenPopover,
      },
      "wireframe",
    );

    expect(onRenderModeChange).toHaveBeenCalledWith("wireframe");
    expect(setInternalRenderMode).not.toHaveBeenCalled();
    expect(setOpenPopover).toHaveBeenCalledWith(null);
  });

  it("patches scoped parts for draw mode changes and only syncs global mode for universe scope", () => {
    const onMeshPartViewStatePatch = vi.fn();
    const onRenderModeChange = vi.fn();
    const setInternalRenderMode = vi.fn();
    const setOpenPopover = vi.fn();

    applyToolbarRenderModeCommand(
      {
        hasMeshParts: true,
        toolbarStylePartIds: ["part-a", "part-b"],
        selectionScope: { kind: "part", partId: "part-a" },
        onMeshPartViewStatePatch,
        onRenderModeChange,
        setInternalRenderMode,
        setOpenPopover,
      },
      "points",
    );

    expect(onMeshPartViewStatePatch).toHaveBeenCalledWith(["part-a", "part-b"], {
      renderMode: "points",
    });
    expect(onRenderModeChange).not.toHaveBeenCalled();
    expect(setInternalRenderMode).not.toHaveBeenCalled();
  });

  it("routes opacity changes to scoped part patches when toolbar acts on parts", () => {
    const onMeshPartViewStatePatch = vi.fn();
    const onOpacityChange = vi.fn();
    const setInternalOpacity = vi.fn();

    applyToolbarOpacityCommand(
      {
        hasMeshParts: true,
        toolbarStylePartIds: ["part-a"],
        onMeshPartViewStatePatch,
        onOpacityChange,
        setInternalOpacity,
      },
      57,
    );

    expect(onMeshPartViewStatePatch).toHaveBeenCalledWith(["part-a"], { opacity: 57 });
    expect(onOpacityChange).not.toHaveBeenCalled();
    expect(setInternalOpacity).not.toHaveBeenCalled();
  });

  it("updates the global field when color field changes at universe scope", () => {
    const onMeshPartViewStatePatch = vi.fn();
    const setField = vi.fn();

    applyToolbarColorFieldCommand(
      {
        hasMeshParts: true,
        toolbarColorPartIds: ["part-a"],
        selectionScope: { kind: "universe" },
        onMeshPartViewStatePatch,
        setField,
      },
      "quality",
    );

    expect(onMeshPartViewStatePatch).toHaveBeenCalledWith(["part-a"], {
      colorField: "quality",
    });
    expect(setField).toHaveBeenCalledWith("quality");
  });

  it("sets clip through the external callback when provided", () => {
    const onClipEnabledChange = vi.fn();
    const setInternalClipEnabled = vi.fn();

    setClipEnabledCommand(
      {
        onClipEnabledChange,
        setInternalClipEnabled,
      },
      true,
    );

    expect(onClipEnabledChange).toHaveBeenCalledWith(true);
    expect(setInternalClipEnabled).not.toHaveBeenCalled();
  });

  it("toggleClip flips the current clip state through the same command path", () => {
    const onClipEnabledChange = vi.fn();
    const setInternalClipEnabled = vi.fn();

    toggleClipCommand({
      clipEnabled: true,
      onClipEnabledChange,
      setInternalClipEnabled,
    });

    expect(onClipEnabledChange).toHaveBeenCalledWith(false);
    expect(setInternalClipEnabled).not.toHaveBeenCalled();
  });
});
