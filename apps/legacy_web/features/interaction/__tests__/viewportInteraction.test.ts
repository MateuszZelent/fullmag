import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEWPORT_INTERACTION,
  setViewportMode,
  setTransformTool,
  setTransformScope,
  startDrag,
  commitDrag,
  cancelDrag,
} from "../model/viewportInteraction";

describe("setViewportMode", () => {
  it("switches to camera mode", () => {
    const state = setViewportMode(DEFAULT_VIEWPORT_INTERACTION, "camera");
    expect(state.mode).toBe("camera");
  });

  it("switches to manipulate mode", () => {
    const state = setViewportMode(DEFAULT_VIEWPORT_INTERACTION, "manipulate");
    expect(state.mode).toBe("manipulate");
  });

  it("hides gizmo in camera mode", () => {
    const withGizmo = { ...DEFAULT_VIEWPORT_INTERACTION, gizmoVisible: true };
    const state = setViewportMode(withGizmo, "camera");
    expect(state.gizmoVisible).toBe(false);
  });
});

describe("setTransformTool", () => {
  it("auto-switches to manipulate for move", () => {
    const state = setTransformTool(DEFAULT_VIEWPORT_INTERACTION, "move");
    expect(state.mode).toBe("manipulate");
    expect(state.tool).toBe("move");
  });

  it("auto-switches to manipulate for rotate", () => {
    const state = setTransformTool(DEFAULT_VIEWPORT_INTERACTION, "rotate");
    expect(state.mode).toBe("manipulate");
    expect(state.tool).toBe("rotate");
  });

  it("auto-switches to manipulate for scale", () => {
    const state = setTransformTool(DEFAULT_VIEWPORT_INTERACTION, "scale");
    expect(state.mode).toBe("manipulate");
    expect(state.tool).toBe("scale");
  });

  it("select tool does not force manipulate mode", () => {
    const camera = { ...DEFAULT_VIEWPORT_INTERACTION, mode: "camera" as const };
    const state = setTransformTool(camera, "select");
    expect(state.mode).toBe("camera");
    expect(state.tool).toBe("select");
  });
});

describe("setTransformScope", () => {
  it("updates scope", () => {
    const state = setTransformScope(DEFAULT_VIEWPORT_INTERACTION, "local");
    expect(state.scope).toBe("local");
  });

  it("clears scope with null", () => {
    const withScope = { ...DEFAULT_VIEWPORT_INTERACTION, scope: "local" as const };
    const state = setTransformScope(withScope, null);
    expect(state.scope).toBeNull();
  });
});

describe("drag lifecycle", () => {
  it("starts drag", () => {
    const drag = { axis: "x" as const, startWorld: [0, 0, 0] as [number, number, number], startScreen: [0, 0] as [number, number] };
    const state = startDrag(DEFAULT_VIEWPORT_INTERACTION, drag);
    expect(state.activeDrag).toBeTruthy();
    expect(state.activeDrag?.axis).toBe("x");
  });

  it("commits drag", () => {
    const drag = { axis: "x" as const, startWorld: [0, 0, 0] as [number, number, number], startScreen: [0, 0] as [number, number] };
    const dragging = startDrag(DEFAULT_VIEWPORT_INTERACTION, drag);
    const state = commitDrag(dragging);
    expect(state.activeDrag).toBeNull();
  });

  it("cancels drag", () => {
    const drag = { axis: "x" as const, startWorld: [0, 0, 0] as [number, number, number], startScreen: [0, 0] as [number, number] };
    const dragging = startDrag(DEFAULT_VIEWPORT_INTERACTION, drag);
    const state = cancelDrag(dragging);
    expect(state.activeDrag).toBeNull();
  });
});
