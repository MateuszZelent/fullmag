/**
 * P1 unit tests — geometry-builder store
 *
 * Verifies dirty chain semantics, transform transactions, undo/redo, and
 * addPrimitive smart placement via the Zustand store.
 *
 * The store is a module-level singleton. Each test resets it to the initial
 * state via `useGeometryBuilderStore.setState(initialSnapshot, true)` before
 * running assertions.
 */
import { describe, expect, it, beforeEach } from "vitest";

import { useGeometryBuilderStore } from "../../features/geometry-builder/store/useGeometryBuilderStore";
import { CLEAN_STATE } from "../../features/geometry-builder/model/types";
import type { PrimitiveNode } from "../../features/geometry-builder/model/types";

// ── Helpers ───────────────────────────────────────────────────

/** Reset the store data to a clean initial state before each test.
 * Does NOT pass `replace=true` so that Zustand preserves all action functions. */
function resetStore() {
  useGeometryBuilderStore.setState({
    graph: {
      version: "geometry_graph.v1" as const,
      universe: {
        id: "universe",
        kind: "universe" as const,
        boundsMode: "box" as const,
        size: [1e-6, 1e-6, 1e-6],
        origin: [0, 0, 0],
        visibility: true,
        lockTransforms: true,
        policy: "preview_only_block_build" as const,
      },
      nodes: [],
    },
    dirty: { ...CLEAN_STATE },
    revisions: { geometryGraphRevision: 0, geometryRealizationRevision: null, meshRevision: null },
    builderMode: { enabled: false, submode: "select" as const },
    viewportTool: "camera" as const,
    snapSettings: {
      enabled: false,
      translateStepMeters: 10e-9,
      rotateStepDeg: 5,
      scaleStep: 0.05,
    },
    builderSelection: { type: "none" as const },
    constraintPolicy: "preview_only_block_build" as const,
    clipAcknowledged: false,
    geometryRealization: null,
    meshSnapshot: null,
    cameraFocusRequest: null,
    undoStack: [],
    redoStack: [],
    activeTransformTransaction: null,
  });
}

function getState() {
  return useGeometryBuilderStore.getState();
}

// ── Dirty chain ───────────────────────────────────────────────

describe("dirty chain semantics", () => {
  beforeEach(resetStore);

  it("setPrimitiveVisible does NOT set geometryDraftDirty", () => {
    const id = getState().addPrimitive("box");
    resetStore(); // reset dirty flags
    // Re-add without dirty side effects
    useGeometryBuilderStore.setState((s) => ({
      graph: {
        ...s.graph,
        nodes: [
          {
            id,
            kind: "primitive",
            primitiveKind: "box",
            name: "Box 001",
            enabled: true,
            visible: true,
            locked: false,
            transform: { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            params: { kind: "box", data: { size: [200e-9, 200e-9, 200e-9] } },
            materialBindingId: null,
            tags: [],
          } satisfies PrimitiveNode,
        ],
      },
      dirty: { ...CLEAN_STATE },
    }));

    getState().setPrimitiveVisible(id, false);
    expect(getState().dirty.geometryDraftDirty).toBe(false);
    expect(getState().dirty.meshDirty).toBe(false);
  });

  it("setPrimitiveEnabled DOES set full dirty chain", () => {
    const id = getState().addPrimitive("box");
    // Clear dirty state set by addPrimitive
    useGeometryBuilderStore.setState({ dirty: { ...CLEAN_STATE } });

    getState().setPrimitiveEnabled(id, false);
    const { dirty } = getState();
    expect(dirty.geometryDraftDirty).toBe(true);
    expect(dirty.geometryRealizationDirty).toBe(true);
    expect(dirty.meshDirty).toBe(true);
    expect(dirty.initialStateDirty).toBe(true);
    expect(dirty.resultsDirty).toBe(true);
  });

  it("renamePrimitive sets geometryRealizationDirty but NOT meshDirty", () => {
    const id = getState().addPrimitive("box");
    useGeometryBuilderStore.setState({ dirty: { ...CLEAN_STATE } });

    getState().renamePrimitive(id, "My Layer");
    const { dirty } = getState();
    expect(dirty.geometryRealizationDirty).toBe(true);
    expect(dirty.meshDirty).toBe(false);
    expect(dirty.geometryDraftDirty).toBe(false);
  });

  it("setPrimitiveLocked does NOT set any dirty flags", () => {
    const id = getState().addPrimitive("box");
    useGeometryBuilderStore.setState({ dirty: { ...CLEAN_STATE } });

    getState().setPrimitiveLocked(id, true);
    const { dirty } = getState();
    expect(dirty.geometryDraftDirty).toBe(false);
    expect(dirty.geometryRealizationDirty).toBe(false);
    expect(dirty.meshDirty).toBe(false);
  });

  it("setPrimitiveParams sets full dirty chain", () => {
    const id = getState().addPrimitive("box");
    useGeometryBuilderStore.setState({ dirty: { ...CLEAN_STATE } });

    const prim = getState().getPrimitive(id)!;
    getState().setPrimitiveParams(id, { kind: "box", data: { size: [100e-9, 100e-9, 100e-9] } });
    const { dirty } = getState();
    expect(dirty.geometryDraftDirty).toBe(true);
    expect(dirty.meshDirty).toBe(true);
  });
});

// ── Undo / Redo ───────────────────────────────────────────────

describe("undo / redo", () => {
  beforeEach(resetStore);

  it("undo restores nodes after addPrimitive", () => {
    expect(getState().graph.nodes).toHaveLength(0);
    getState().addPrimitive("box");
    expect(getState().graph.nodes).toHaveLength(1);

    getState().undo();
    expect(getState().graph.nodes).toHaveLength(0);
  });

  it("redo re-applies undone addPrimitive", () => {
    getState().addPrimitive("cylinder");
    getState().undo();
    expect(getState().graph.nodes).toHaveLength(0);

    getState().redo();
    expect(getState().graph.nodes).toHaveLength(1);
    expect((getState().graph.nodes[0] as PrimitiveNode).primitiveKind).toBe("cylinder");
  });

  it("canUndo returns false on empty stack", () => {
    expect(getState().canUndo()).toBe(false);
  });

  it("canRedo returns false on empty stack", () => {
    expect(getState().canRedo()).toBe(false);
  });

  it("addPrimitive clears redoStack", () => {
    getState().addPrimitive("box");
    getState().undo();
    expect(getState().canRedo()).toBe(true);

    getState().addPrimitive("cylinder"); // new action clears redo
    expect(getState().canRedo()).toBe(false);
  });
});

// ── Transform transactions ────────────────────────────────────

describe("transform transactions", () => {
  beforeEach(resetStore);

  it("commitTransformTransaction applies final transform and pushes one undo entry", () => {
    const id = getState().addPrimitive("box");
    const undoCountBefore = getState().undoStack.length;

    getState().beginTransformTransaction(id);
    getState().updateTransformPreview(id, { translation: [10e-9, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    getState().updateTransformPreview(id, { translation: [20e-9, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    getState().commitTransformTransaction(id, { translation: [30e-9, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

    const prim = getState().getPrimitive(id)!;
    expect(prim.transform.translation[0]).toBeCloseTo(30e-9);
    // Exactly one new undo entry for the whole drag
    expect(getState().undoStack.length).toBe(undoCountBefore + 1);
  });

  it("cancelTransformTransaction restores pre-drag state", () => {
    const id = getState().addPrimitive("box");
    const originalTranslation = [...getState().getPrimitive(id)!.transform.translation];

    getState().beginTransformTransaction(id);
    getState().updateTransformPreview(id, { translation: [50e-9, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    getState().cancelTransformTransaction(id);

    const prim = getState().getPrimitive(id)!;
    expect(prim.transform.translation[0]).toBeCloseTo(originalTranslation[0]);
    expect(getState().activeTransformTransaction).toBeNull();
  });

  it("updateTransformPreview does NOT push undo entries", () => {
    const id = getState().addPrimitive("box");
    const undoCountBefore = getState().undoStack.length;

    getState().beginTransformTransaction(id);
    getState().updateTransformPreview(id, { translation: [10e-9, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    getState().updateTransformPreview(id, { translation: [20e-9, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

    expect(getState().undoStack.length).toBe(undoCountBefore);
  });
});

// ── Viewport tool ─────────────────────────────────────────────

describe("viewportTool", () => {
  beforeEach(resetStore);

  it("initial tool is camera", () => {
    expect(getState().viewportTool).toBe("camera");
  });

  it("setViewportTool updates the tool", () => {
    getState().setViewportTool("move");
    expect(getState().viewportTool).toBe("move");
  });

  it("toggleSnap flips snap enabled state", () => {
    expect(getState().snapSettings.enabled).toBe(false);
    getState().toggleSnap();
    expect(getState().snapSettings.enabled).toBe(true);
    getState().toggleSnap();
    expect(getState().snapSettings.enabled).toBe(false);
  });
});

// ── Selection ─────────────────────────────────────────────────

describe("selection", () => {
  beforeEach(resetStore);

  it("addPrimitive automatically selects the new primitive", () => {
    const id = getState().addPrimitive("box");
    const sel = getState().builderSelection;
    expect(sel.type).toBe("primitive");
    if (sel.type === "primitive") expect(sel.id).toBe(id);
  });

  it("removePrimitive clears selection for that primitive", () => {
    const id = getState().addPrimitive("box");
    getState().removePrimitive(id);
    expect(getState().builderSelection.type).toBe("none");
  });
});

// ── Build policy / clipping ack ──────────────────────────────

describe("build policy and clipping acknowledgement", () => {
  beforeEach(resetStore);

  it("getGeometryBuildBlockedReason blocks out-of-bounds for block_build policy", () => {
    const id = getState().addPrimitive("box");
    const node = getState().getPrimitive(id);
    if (!node) throw new Error("primitive missing");
    getState().setUniversePolicy("block_build");
    getState().setPrimitiveTransform(id, {
      ...node.transform,
      translation: [100e-6, 0, 0],
    });
    const reason = getState().getGeometryBuildBlockedReason();
    expect(reason).toContain("Universe");
  });

  it("clip_with_explicit_ack requires acknowledgement before Build Geometry", () => {
    const id = getState().addPrimitive("box");
    const node = getState().getPrimitive(id);
    if (!node) throw new Error("primitive missing");
    getState().setUniversePolicy("clip_with_explicit_ack");
    getState().setPrimitiveTransform(id, {
      ...node.transform,
      translation: [100e-6, 0, 0],
    });
    const blockedBeforeAck = getState().getGeometryBuildBlockedReason();
    expect(blockedBeforeAck).toContain("Clipping");
    getState().setClipAcknowledged(true);
    expect(getState().getGeometryBuildBlockedReason()).toBeNull();
  });

  it("buildGeometry is a no-op while blocked by policy", () => {
    const id = getState().addPrimitive("box");
    const node = getState().getPrimitive(id);
    if (!node) throw new Error("primitive missing");
    getState().setUniversePolicy("block_build");
    getState().setPrimitiveTransform(id, {
      ...node.transform,
      translation: [100e-6, 0, 0],
    });
    const before = getState().revisions.geometryRealizationRevision;
    getState().buildGeometry();
    const after = getState().revisions.geometryRealizationRevision;
    expect(after).toBe(before);
  });
});

// ── Camera focus requests ────────────────────────────────────

describe("camera focus requests", () => {
  beforeEach(resetStore);

  it("requestFocusSelected stores selected focus request and bumps revision", () => {
    getState().requestFocusSelected();
    const request = getState().cameraFocusRequest;
    expect(request).not.toBeNull();
    expect(request?.kind).toBe("selected");
    expect(request?.revision).toBe(1);
    getState().requestFocusSelected();
    expect(getState().cameraFocusRequest?.revision).toBe(2);
  });

  it("requestFrameAll stores frame-all focus request", () => {
    getState().requestFrameAll();
    const request = getState().cameraFocusRequest;
    expect(request).not.toBeNull();
    expect(request?.kind).toBe("all");
  });
});
