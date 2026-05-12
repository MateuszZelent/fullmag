import { describe, expect, it } from "vitest";

import {
  AIRBOX_VISUALIZATION_TARGET,
  airboxVisualizationStatePatchFromTargetPatch,
  ObjectVisualizationController,
  renderModePatch,
  resolveAirboxVisualizationSettingsFromState,
  resolveVisualizationSettings,
  resolveVisualizationTargetFromSelection,
  visualizationTargetKey,
} from "./ObjectVisualizationController";

describe("ObjectVisualizationController", () => {
  it("resolves canonical target ids from object and airbox selections", () => {
    expect(
      resolveVisualizationTargetFromSelection({
        kind: "object.visualization",
        label: "Free layer",
        nodeId: "model:object:free-layer:visualization",
        objectId: "free-layer",
      }),
    ).toEqual({
      id: "free-layer",
      kind: "object",
      label: "Free layer",
    });

    expect(
      resolveVisualizationTargetFromSelection({
        kind: "airbox.visualization",
        label: "Airbox Visualization",
        nodeId: "model:airbox:visualization",
        objectId: null,
      }),
    ).toEqual(AIRBOX_VISUALIZATION_TARGET);
  });

  it("patches and clears target overrides without storing resource data", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };

    controller.patchTarget(target, {
      opacityPercent: 41,
      renderMode: "wireframe",
      vectorsVisible: true,
    });

    expect(controller.getSettings(target)).toMatchObject({
      opacityPercent: 41,
      shaderVisible: false,
      vectorsVisible: true,
      wireframeVisible: true,
    });
    expect(controller.getSnapshot().overrides[visualizationTargetKey(target)])
      .toMatchObject({
        opacityPercent: 41,
        renderMode: "wireframe",
      });

    controller.clearTarget(target);

    expect(controller.getSettings(target)).toMatchObject({
      opacityPercent: 55,
      renderMode: "surface+edges",
    });
  });

  it("keeps the external-store snapshot reference stable between changes", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };
    const initial = controller.getSnapshot();

    expect(controller.getSnapshot()).toBe(initial);

    controller.patchTarget(target, {
      opacityPercent: 41,
      renderMode: "wireframe",
    });

    const patched = controller.getSnapshot();
    expect(patched).not.toBe(initial);
    expect(controller.getSnapshot()).toBe(patched);

    controller.patchTarget(target, {
      opacityPercent: 41,
      renderMode: "wireframe",
    });

    expect(controller.getSnapshot()).toBe(patched);

    controller.clearTarget(target);

    const cleared = controller.getSnapshot();
    expect(cleared).not.toBe(patched);
    expect(controller.getSnapshot()).toBe(cleared);
  });

  it("normalizes render-mode patches into primitive layer flags", () => {
    expect(renderModePatch("surface+edges")).toMatchObject({
      pointsVisible: false,
      shaderVisible: true,
      wireframeVisible: true,
    });
    expect(renderModePatch("points")).toMatchObject({
      pointsVisible: true,
      shaderVisible: false,
      wireframeVisible: false,
    });
  });

  it("merges per-target overrides over a caller-provided global base", () => {
    const controller = new ObjectVisualizationController();
    const target = { id: "free-layer", kind: "object" as const };

    controller.patchTarget(target, {
      opacityPercent: 35,
      wireframeVisible: true,
    });

    expect(
      resolveVisualizationSettings(controller.getSnapshot(), target, {
        opacityPercent: 80,
        pointsVisible: true,
        renderMode: "points",
        shaderVisible: false,
        vectorsVisible: true,
        visible: true,
        wireframeVisible: false,
      }),
    ).toMatchObject({
      opacityPercent: 35,
      pointsVisible: true,
      shaderVisible: false,
      vectorsVisible: true,
      wireframeVisible: true,
    });
  });

  it("maps backend airbox layer state into target visualization settings", () => {
    expect(
      resolveAirboxVisualizationSettingsFromState({
        layers: {
          airbox: {
            opacity: 0.31,
            points: { opacity: 1, visible: true },
            surface: { opacity: 1, visible: false },
            vectors: { density: 64, domain: "airbox_only", visible: true },
            visible: true,
            wireframe: { opacity: 1, visible: true },
          },
        },
      }),
    ).toMatchObject({
      opacityPercent: 31,
      pointsVisible: true,
      renderMode: "points",
      shaderVisible: false,
      vectorsVisible: true,
      visible: true,
      wireframeVisible: true,
    });
  });

  it("builds backend airbox layer patches from target display patches", () => {
    expect(
      airboxVisualizationStatePatchFromTargetPatch({
        opacityPercent: 25,
        shaderVisible: true,
        vectorsVisible: true,
        visible: false,
        wireframeVisible: false,
      }),
    ).toEqual({
      layers: {
        airbox: {
          opacity: 0.25,
          surface: { visible: true },
          vectors: { domain: "airbox_only", visible: true },
          visible: false,
          wireframe: { visible: false },
        },
      },
    });
  });
});
