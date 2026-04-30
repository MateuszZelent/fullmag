import { describe, expect, it } from "vitest";

import {
  airboxDisplayStateFromRenderMode,
  resolveAirboxDisplayState,
  resolveAirboxRenderMode,
} from "../airboxDisplay";

describe("resolveAirboxRenderMode", () => {
  it("switches wireframe-only airbox to shaded when wireframe is toggled off", () => {
    expect(resolveAirboxRenderMode("wireframe", { wireframe: false })).toBe("wireframe");
    expect(
      resolveAirboxDisplayState(airboxDisplayStateFromRenderMode("wireframe"), {
        wireframe: false,
      }),
    ).toMatchObject({
      geometryVisible: false,
    });
  });

  it("switches shaded-only airbox to wireframe when shaded is toggled off", () => {
    expect(resolveAirboxRenderMode("surface", { shaded: false })).toBe("wireframe");
    expect(
      resolveAirboxDisplayState(airboxDisplayStateFromRenderMode("surface"), {
        shaded: false,
      }),
    ).toMatchObject({
      geometryVisible: false,
    });
  });

  it("keeps shaded and wireframe independently toggleable from combined mode", () => {
    expect(resolveAirboxRenderMode("surface+edges", { wireframe: false })).toBe("surface");
    expect(resolveAirboxRenderMode("surface+edges", { shaded: false })).toBe("wireframe");
  });

  it("uses points as an exclusive render mode and keeps point configuration when disabled", () => {
    expect(resolveAirboxRenderMode("surface+edges", { points: true })).toBe("points");
    expect(resolveAirboxRenderMode("points", { points: false })).toBe("points");
    expect(
      resolveAirboxDisplayState(airboxDisplayStateFromRenderMode("points"), {
        points: false,
      }),
    ).toMatchObject({
      geometryVisible: false,
    });
  });

  it("applies explicit radio render mode directly", () => {
    expect(resolveAirboxRenderMode("wireframe", { renderMode: "surface+edges" })).toBe("surface+edges");
    expect(resolveAirboxRenderMode("wireframe", { renderMode: "mesh" })).toBe("wireframe");
  });

  it("preserves wireframe while switching full/surface extent", () => {
    expect(
      resolveAirboxDisplayState(airboxDisplayStateFromRenderMode("wireframe"), {
        wireframeScope: "full",
      }),
    ).toMatchObject({
      renderMode: "wireframe",
      wireframeScope: "full",
    });
  });

  it("preserves points while switching full/surface extent", () => {
    expect(
      resolveAirboxDisplayState(airboxDisplayStateFromRenderMode("points"), {
        pointsScope: "full",
      }),
    ).toMatchObject({
      renderMode: "points",
      pointsScope: "full",
    });
  });

  it("updates vectors extent without changing point render state", () => {
    expect(
      resolveAirboxDisplayState(
        {
          ...airboxDisplayStateFromRenderMode("points"),
          pointsScope: "full",
          vectorsScope: "surface",
        },
        { vectorsScope: "full" },
      ),
    ).toMatchObject({
      geometryVisible: true,
      renderMode: "points",
      pointsScope: "full",
      vectorsScope: "full",
    });
  });

  it("updates points extent without changing vectors extent", () => {
    expect(
      resolveAirboxDisplayState(
        {
          ...airboxDisplayStateFromRenderMode("wireframe"),
          pointsScope: "surface",
          vectorsScope: "full",
        },
        { pointsScope: "full" },
      ),
    ).toMatchObject({
      renderMode: "wireframe",
      pointsScope: "full",
      vectorsScope: "full",
    });
  });

  it("enables points without resetting vector extent", () => {
    expect(
      resolveAirboxDisplayState(
        {
          ...airboxDisplayStateFromRenderMode("wireframe"),
          vectorsScope: "full",
        },
        { points: true },
      ),
    ).toMatchObject({
      renderMode: "points",
      pointsScope: "surface",
      vectorsScope: "full",
    });
  });

  it("maps legacy mesh mode to full wireframe without shaded surface", () => {
    expect(airboxDisplayStateFromRenderMode("mesh")).toMatchObject({
      geometryVisible: true,
      renderMode: "wireframe",
      wireframeScope: "full",
    });
  });

  it("turns geometry back on when any primitive mode is enabled", () => {
    expect(
      resolveAirboxDisplayState(
        {
          ...airboxDisplayStateFromRenderMode("wireframe"),
          geometryVisible: false,
        },
        { wireframe: true },
      ),
    ).toMatchObject({
      geometryVisible: true,
      renderMode: "wireframe",
    });
  });
});
