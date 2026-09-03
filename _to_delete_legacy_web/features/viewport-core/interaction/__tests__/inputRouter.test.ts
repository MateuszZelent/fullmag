/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
import { describe, expect, it } from "vitest";

import { routeInput } from "../inputRouter";

describe("routeInput", () => {
  it("enters lasso select on shift + left click", () => {
    const result = routeInput("camera-navigate", {
      type: "pointer-down",
      button: 0,
      shiftKey: true,
      ctrlKey: false,
    });
    expect(result).toEqual({ nextMode: "lasso-select", consumed: true });
  });

  it("returns to camera navigate on escape", () => {
    expect(routeInput("gizmo-translate", { type: "escape" })).toEqual({
      nextMode: "camera-navigate",
      consumed: true,
    });
  });

  it("keeps gizmo mode while pointer moves during manipulation", () => {
    expect(routeInput("gizmo-rotate", { type: "pointer-move", dx: 4, dy: 1 })).toEqual({
      nextMode: "gizmo-rotate",
      consumed: true,
    });
  });
});
