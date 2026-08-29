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
      expectedTopologyFingerprint: null,
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
      femCarrier: null,
      mask,
      previewId: "preview-1",
    });
    expect(model?.carrierKind).toBe("fdm-cells");
    expect([...model!.positions]).toEqual([0.5, 1, 1.5, 1.5, 3, 1.5]);
  });

  it("maps frozen FEM local nodes through the versioned P1 render carrier", () => {
    const model = buildFrozenSpinsOverlayModel({
      current: true,
      expectedTopologyFingerprint: `sha256:${"2".repeat(64)}`,
      fdmDomain: null,
      femCarrier: {
        schemaVersion: "fullmag.fem-local-node-render.v1",
        carrierFingerprint: `sha256:${"1".repeat(64)}`,
        meshFingerprint: `sha256:${"2".repeat(64)}`,
        feSpaceOrder: 1,
        vectorOrdering: "by_nodes",
        localNodeCount: 4,
        renderVertexPositions: Float64Array.from([
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
          0, 0, 1,
        ]),
      },
      mask,
      previewId: "preview-2",
    });
    expect(model?.carrierKind).toBe("fem-local-nodes");
    expect(model?.frozenCount).toBe(2);
    expect(model?.renderedCount).toBe(2);
    expect([...model!.positions]).toEqual([
      0, 0, 0,
      0, 0, 1,
    ]);
  });

  it("fails closed for malformed FEM carrier identity", () => {
    const malformedCarrier = {
      schemaVersion: "fullmag.fem-local-node-render.v1" as const,
      carrierFingerprint: "not-a-fingerprint",
      meshFingerprint: `sha256:${"2".repeat(64)}`,
      feSpaceOrder: 1,
      vectorOrdering: "by_nodes" as const,
      localNodeCount: 4,
      renderVertexPositions: Float32Array.from([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0,
        0, 0, 1,
      ]),
    };
    expect(
      buildFrozenSpinsOverlayModel({
        current: true,
        expectedTopologyFingerprint: `sha256:${"2".repeat(64)}`,
        fdmDomain: null,
        femCarrier: malformedCarrier,
        mask,
        previewId: "preview-malformed",
      }),
    ).toBeNull();
  });

  it("fails closed when mask and carrier cardinalities disagree", () => {
    expect(
      buildFrozenSpinsOverlayModel({
        current: false,
        expectedTopologyFingerprint: null,
        fdmDomain: null,
        femCarrier: null,
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
