import { describe, expect, it } from "vitest";

import { resolveAirboxRenderMode } from "../airboxDisplay";

describe("resolveAirboxRenderMode", () => {
  it("switches wireframe-only airbox to shaded when wireframe is toggled off", () => {
    expect(resolveAirboxRenderMode("wireframe", { wireframe: false })).toBe("surface");
  });

  it("switches shaded-only airbox to wireframe when shaded is toggled off", () => {
    expect(resolveAirboxRenderMode("surface", { shaded: false })).toBe("wireframe");
  });

  it("keeps shaded and wireframe independently toggleable from combined mode", () => {
    expect(resolveAirboxRenderMode("surface+edges", { wireframe: false })).toBe("surface");
    expect(resolveAirboxRenderMode("surface+edges", { shaded: false })).toBe("wireframe");
  });

  it("uses points as an exclusive render mode and falls back when disabled", () => {
    expect(resolveAirboxRenderMode("surface+edges", { points: true })).toBe("points");
    expect(resolveAirboxRenderMode("points", { points: false })).toBe("wireframe");
  });

  it("applies explicit radio render mode directly", () => {
    expect(resolveAirboxRenderMode("wireframe", { renderMode: "surface+edges" })).toBe("surface+edges");
    expect(resolveAirboxRenderMode("wireframe", { renderMode: "mesh" })).toBe("mesh");
  });
});
