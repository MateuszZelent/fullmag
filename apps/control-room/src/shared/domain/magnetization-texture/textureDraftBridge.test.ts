import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveTargetBoundsMeters } from "./boundsResolver";
import { createDefaultMagneticTextureDraft } from "./presetDefaults";
import {
  beginTextureGizmoGesture,
  getTextureDraftBridgeSnapshot,
  handleTextureGizmoShortcutKey,
  isTextureGizmoHandleModeActive,
  registerTextureInspectorBinding,
  resetTextureDraftBridgeForTests,
  resolveActiveTextureGizmoMode,
  setTextureGizmoMode,
  toggleTextureGizmo,
  unregisterTextureInspectorBinding,
} from "./textureDraftBridge";

describe("textureDraftBridge Camera vs Gizmo mode contract", () => {
  beforeEach(() => {
    resetTextureDraftBridgeForTests();
  });

  afterEach(() => {
    resetTextureDraftBridgeForTests();
  });

  it("starts in Camera orbit mode and allows Q/W/E/R shortcuts without pressing T first", () => {
    expect(resolveActiveTextureGizmoMode(getTextureDraftBridgeSnapshot())).toBe("view");
    expect(isTextureGizmoHandleModeActive(getTextureDraftBridgeSnapshot(), "disk")).toBe(false);

    expect(handleTextureGizmoShortcutKey("w")).toBe(true);
    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(true);
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("translate");
    expect(resolveActiveTextureGizmoMode(getTextureDraftBridgeSnapshot())).toBe("translate");

    expect(handleTextureGizmoShortcutKey("e")).toBe(true);
    expect(resolveActiveTextureGizmoMode(getTextureDraftBridgeSnapshot())).toBe("rotate");

    expect(handleTextureGizmoShortcutKey("r")).toBe(true);
    expect(resolveActiveTextureGizmoMode(getTextureDraftBridgeSnapshot())).toBe("scale");

    expect(handleTextureGizmoShortcutKey("q")).toBe(true);
    expect(resolveActiveTextureGizmoMode(getTextureDraftBridgeSnapshot())).toBe("view");
    expect(isTextureGizmoHandleModeActive(getTextureDraftBridgeSnapshot(), "disk")).toBe(false);
  });

  it("activates gizmo handle lock only when an analytical texture target is bound and mode is translate/rotate/scale", () => {
    const owner = Symbol("inspector");
    const target = { kind: "object" as const, objectId: "disk" };
    const bounds = resolveTargetBoundsMeters(null, target);
    const draft = createDefaultMagneticTextureDraft("bloch_skyrmion", bounds, "object");

    // Pre-selecting W before an object is bound remembers mode without locking camera orbit
    setTextureGizmoMode("scale");
    expect(resolveActiveTextureGizmoMode(getTextureDraftBridgeSnapshot())).toBe("scale");
    expect(isTextureGizmoHandleModeActive(getTextureDraftBridgeSnapshot(), null)).toBe(false);

    // Binding the object immediately activates handle mode
    registerTextureInspectorBinding(owner, {
      target,
      draft,
      bounds,
      patchDraft: vi.fn(),
      fitCharacteristicSize: vi.fn(),
      resetTransform: vi.fn(),
    });
    expect(isTextureGizmoHandleModeActive(getTextureDraftBridgeSnapshot(), "disk")).toBe(true);
    expect(isTextureGizmoHandleModeActive(getTextureDraftBridgeSnapshot(), "other")).toBe(false);

    // Switching to Camera (Q) unlocks camera orbit while keeping texture binding
    setTextureGizmoMode("view");
    expect(isTextureGizmoHandleModeActive(getTextureDraftBridgeSnapshot(), "disk")).toBe(false);

    // Toggling gizmo back on from "view" promotes mode to "translate"
    toggleTextureGizmo(false);
    toggleTextureGizmo(true);
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("translate");
    expect(isTextureGizmoHandleModeActive(getTextureDraftBridgeSnapshot(), "disk")).toBe(true);

    // Unmounting MagneticTextureInspectorPanel (switching to Visualization / Geometry) cleans up gizmo
    beginTextureGizmoGesture();
    unregisterTextureInspectorBinding(owner);
    expect(getTextureDraftBridgeSnapshot().activeBinding).toBeNull();
    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(false);
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("view");
    expect(getTextureDraftBridgeSnapshot().gestureActive).toBe(false);
    expect(resolveActiveTextureGizmoMode(getTextureDraftBridgeSnapshot())).toBe("view");
    expect(isTextureGizmoHandleModeActive(getTextureDraftBridgeSnapshot(), "disk")).toBe(false);
  });
});
