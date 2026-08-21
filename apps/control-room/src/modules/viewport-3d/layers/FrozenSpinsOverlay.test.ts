import { describe, expect, it } from "vitest";

import { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import {
  buildFrozenSpinsOverlayModel,
  createFrozenSpinsOverlayResources,
} from "./FrozenSpinsOverlay";

describe("buildFrozenSpinsOverlayModel", () => {
  const mask = {
    bitCount: 4,
    frozenIndices: Uint32Array.from([0, 3]),
    maskSha256: "sha256:mask",
    sceneRevision: 7,
    sourceStateRevision: 8,
  };

  it("maps canonical FDM cell ordinals to exact cell centers", () => {
    const model = buildFrozenSpinsOverlayModel({
      current: true,
      fdmDomain: {
        bounds: null,
        displayCellBudget: 4,
        displayCellCount: 4,
        kind: "fdm-grid",
        origin: [0, 0, 0],
        shape: [2, 2, 1],
        spacing: [1, 2, 3],
        stride: 1,
        totalCells: 4,
      },
      femTrueDofPositions: null,
      mask,
      previewId: "preview-1",
    });
    expect(model?.carrierKind).toBe("fdm-cells");
    expect([...model!.positions]).toEqual([0.5, 1, 1.5, 1.5, 3, 1.5]);
  });

  it("maps an exact node-sized FEM mask to published true-DOF positions", () => {
    const model = buildFrozenSpinsOverlayModel({
      current: true,
      fdmDomain: null,
      femTrueDofPositions: Float64Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
      ]),
      mask,
      previewId: "preview-2",
    });
    expect(model?.carrierKind).toBe("fem-true-dofs");
    expect([...model!.positions]).toEqual([0, 0, 0, 0, 0, 1]);
  });

  it("fails closed when mask and carrier cardinalities disagree", () => {
    expect(
      buildFrozenSpinsOverlayModel({
        current: false,
        fdmDomain: null,
        femTrueDofPositions: null,
        mask,
        previewId: "preview-3",
      }),
    ).toBeNull();
  });

  it("returns tracked geometry and material to baseline on overlay cleanup", () => {
    const tracker = new Viewport3DResourceTracker();
    const resources = createFrozenSpinsOverlayResources(
      Float32Array.from([0, 0, 0]),
      "#ff0000",
    );
    let geometryDisposed = false;
    let materialDisposed = false;
    resources.geometry.addEventListener("dispose", () => { geometryDisposed = true; });
    resources.material.addEventListener("dispose", () => { materialDisposed = true; });
    tracker.track("geometry", resources.geometry);
    tracker.track("material", resources.material);
    expect(tracker.getSnapshot()).toMatchObject({ geometries: 1, materials: 1 });
    tracker.release("geometry", resources.geometry);
    tracker.release("material", resources.material);
    expect(tracker.getSnapshot()).toMatchObject({ geometries: 0, materials: 0 });
    expect({ geometryDisposed, materialDisposed }).toEqual({
      geometryDisposed: true,
      materialDisposed: true,
    });
  });
});
