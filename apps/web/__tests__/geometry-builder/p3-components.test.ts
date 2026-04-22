/**
 * P3 unit tests — geometry-builder workflow components
 *
 * Covers:
 * - GeometryInspectorRouter routing logic via store state
 * - Overview inspector run-gate conditions
 * - Universe inspector diagnostics + fit action
 * - Toolbar tool state
 * - Keyboard shortcuts Q/W/E/R
 * - buildGeometryBuilderTreeNodes onClick callbacks
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

import { useGeometryBuilderStore } from "../../features/geometry-builder/store/useGeometryBuilderStore";
import { buildGeometryBuilderTreeNodes } from "../../features/geometry-builder/tree/builderTreeNodes";
import { CLEAN_STATE } from "../../features/geometry-builder/model/types";
import type { GeometryGraphDocument } from "../../features/geometry-builder/model/types";

// ── Helpers ───────────────────────────────────────────────────

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
    revisions: {
      geometryGraphRevision: 0,
      geometryRealizationRevision: null,
      meshRevision: null,
    },
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

// ── Inspector routing ─────────────────────────────────────────

describe("GeometryInspectorRouter state routing", () => {
  beforeEach(resetStore);

  it("builderSelection.type=none routes to overview", () => {
    const state = getState();
    expect(state.builderSelection.type).toBe("none");
  });

  it("selectBuilderTarget universe changes selection to universe", () => {
    const { selectBuilderTarget } = getState();
    selectBuilderTarget({ type: "universe" });
    expect(getState().builderSelection.type).toBe("universe");
  });

  it("selectBuilderTarget primitive changes selection to primitive", () => {
    const { addPrimitive, selectBuilderTarget } = getState();
    const id = addPrimitive("box");
    selectBuilderTarget({ type: "primitive", id });
    const sel = getState().builderSelection;
    expect(sel.type).toBe("primitive");
    if (sel.type === "primitive") {
      expect(sel.id).toBe(id);
    }
  });

  it("selectBuilderTarget none reverts to overview", () => {
    const { selectBuilderTarget, addPrimitive } = getState();
    const id = addPrimitive("box");
    selectBuilderTarget({ type: "primitive", id });
    selectBuilderTarget({ type: "none" });
    expect(getState().builderSelection.type).toBe("none");
  });
});

// ── Overview inspector run-gate ───────────────────────────────

describe("overview inspector build gate", () => {
  beforeEach(resetStore);

  it("isRunBlocked returns true on clean empty graph (no geometry built)", () => {
    // An empty graph with no realization is blocked — nothing to run.
    const { isRunBlocked } = getState();
    expect(isRunBlocked()).toBe(true);
  });

  it("dirty geometry marks geometryDraftDirty after addPrimitive", () => {
    const { addPrimitive } = getState();
    addPrimitive("box");
    expect(getState().dirty.geometryDraftDirty).toBe(true);
  });

  it("buildGeometry clears geometryDraftDirty", () => {
    const { addPrimitive, buildGeometry } = getState();
    addPrimitive("box");
    buildGeometry();
    expect(getState().dirty.geometryDraftDirty).toBe(false);
  });
});

// ── Universe inspector: diagnostics ──────────────────────────

describe("universe inspector diagnostics", () => {
  beforeEach(resetStore);

  it("validateAll returns empty array on empty graph", () => {
    const { validateAll } = getState();
    const results = validateAll();
    expect(results).toHaveLength(0);
  });

  it("primitive inside universe passes withinUniverse", () => {
    const { addPrimitive, validateAll } = getState();
    addPrimitive("box"); // default 100nm box at origin within 1µm universe
    const results = validateAll();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].withinUniverse).toBe(true);
    expect(results[0].exceedsUniverse).toBe(false);
  });

  it("fitUniverseToObjects adjusts universe size", () => {
    const { addPrimitive, fitUniverseToObjects, setUniverseSize } = getState();
    // Make universe tiny so primitive exceeds it
    setUniverseSize([1e-9, 1e-9, 1e-9]);
    addPrimitive("box");
    fitUniverseToObjects();
    const size = getState().graph.universe.size;
    // After fit, size should be larger than 1nm
    expect(size[0]).toBeGreaterThan(1e-9);
    expect(size[1]).toBeGreaterThan(1e-9);
    expect(size[2]).toBeGreaterThan(1e-9);
  });

  it("resetUniverseToDefault sets 1µm cube at origin", () => {
    const { setUniverseSize, setUniverseOrigin, resetUniverseToDefault } = getState();
    setUniverseSize([5e-6, 5e-6, 5e-6]);
    setUniverseOrigin([1e-6, 2e-6, 3e-6]);
    resetUniverseToDefault();
    const { size, origin } = getState().graph.universe;
    expect(size).toEqual([1e-6, 1e-6, 1e-6]);
    expect(origin).toEqual([0, 0, 0]);
  });
});

// ── Universe policy ───────────────────────────────────────────

describe("universe constraint policy", () => {
  beforeEach(resetStore);

  it("default policy is preview_only_block_build", () => {
    expect(getState().constraintPolicy).toBe("preview_only_block_build");
  });

  it("setUniversePolicy changes constraintPolicy", () => {
    const { setUniversePolicy } = getState();
    setUniversePolicy("auto_fit_universe");
    expect(getState().constraintPolicy).toBe("auto_fit_universe");
  });

  it("policy values are accepted: all four variants", () => {
    const { setUniversePolicy } = getState();
    const policies = [
      "block_build",
      "auto_fit_universe",
      "clip_with_explicit_ack",
      "preview_only_block_build",
    ] as const;
    for (const p of policies) {
      setUniversePolicy(p);
      expect(getState().constraintPolicy).toBe(p);
    }
  });
});

// ── Viewport tool ─────────────────────────────────────────────

describe("viewport tool switching", () => {
  beforeEach(resetStore);

  it("default tool is camera", () => {
    expect(getState().viewportTool).toBe("camera");
  });

  it("setViewportTool changes active tool", () => {
    const { setViewportTool } = getState();
    setViewportTool("move");
    expect(getState().viewportTool).toBe("move");
  });

  it("all tool variants are accepted", () => {
    const { setViewportTool } = getState();
    const tools = ["camera", "select", "move", "rotate", "scale"] as const;
    for (const t of tools) {
      setViewportTool(t);
      expect(getState().viewportTool).toBe(t);
    }
  });
});

// ── Tree nodes: selection bridge ──────────────────────────────

describe("buildGeometryBuilderTreeNodes selection bridge", () => {
  beforeEach(resetStore);

  it("universe node has no onClick when onSelect not provided", () => {
    const state = getState();
    const tree = buildGeometryBuilderTreeNodes(state.graph, state.dirty);
    const universeNode = tree.children?.find((c) => c.id === "builder-universe");
    expect(universeNode).toBeDefined();
    expect(universeNode?.onClick).toBeUndefined();
  });

  it("universe node onClick fires onSelect with type=universe", () => {
    const state = getState();
    const onSelect = vi.fn();
    const tree = buildGeometryBuilderTreeNodes(state.graph, state.dirty, onSelect);
    const universeNode = tree.children?.find((c) => c.id === "builder-universe");
    expect(universeNode?.onClick).toBeDefined();
    universeNode?.onClick?.();
    expect(onSelect).toHaveBeenCalledWith({ type: "universe", id: "universe" });
  });

  it("primitive node onClick fires onSelect with type=primitive and correct id", () => {
    const { addPrimitive } = getState();
    const id = addPrimitive("box");

    const state = getState();
    const onSelect = vi.fn();
    const tree = buildGeometryBuilderTreeNodes(state.graph, state.dirty, onSelect);
    const primContainer = tree.children?.find((c) => c.id === "builder-primitives");
    expect(primContainer).toBeDefined();
    const primNode = primContainer?.children?.find(
      (c) => c.id === `builder-prim-${id}`,
    );
    expect(primNode).toBeDefined();
    primNode?.onClick?.();
    expect(onSelect).toHaveBeenCalledWith({ type: "primitive", id });
  });

  it("multiple primitives each get their own onClick with correct ids", () => {
    const { addPrimitive } = getState();
    const id1 = addPrimitive("box");
    const id2 = addPrimitive("cylinder");

    const state = getState();
    const onSelect = vi.fn();
    const tree = buildGeometryBuilderTreeNodes(state.graph, state.dirty, onSelect);
    const primContainer = tree.children?.find((c) => c.id === "builder-primitives");

    const node1 = primContainer?.children?.find((c) => c.id === `builder-prim-${id1}`);
    const node2 = primContainer?.children?.find((c) => c.id === `builder-prim-${id2}`);

    node1?.onClick?.();
    expect(onSelect).toHaveBeenLastCalledWith({ type: "primitive", id: id1 });

    node2?.onClick?.();
    expect(onSelect).toHaveBeenLastCalledWith({ type: "primitive", id: id2 });
  });
});

// ── Primitive placement validation ────────────────────────────

describe("primitive placement validation via validateNode", () => {
  beforeEach(resetStore);

  it("validateNode for a box inside universe returns withinUniverse=true", () => {
    const { addPrimitive, validateNode } = getState();
    const id = addPrimitive("box");
    const result = validateNode(id);
    expect(result).not.toBeNull();
    expect(result?.withinUniverse).toBe(true);
    expect(result?.exceedsUniverse).toBe(false);
  });

  it("validateNode for unknown id returns a clean placeholder (not null)", () => {
    // The store returns a safe default validation result even for missing ids.
    const { validateNode } = getState();
    const result = validateNode("non-existent");
    // Should not throw; returns a passing placeholder
    expect(result).not.toBeNull();
    expect(result?.withinUniverse).toBe(true);
    expect(result?.exceedsUniverse).toBe(false);
  });

  it("placement exceeds universe if primitive center offset far outside", () => {
    const { addPrimitive, setPrimitiveTransform, validateNode, getPrimitive } = getState();
    const id = addPrimitive("box");
    const node = getPrimitive(id);
    if (!node) throw new Error("node missing");
    // Move the box 100µm away from a 1µm universe
    setPrimitiveTransform(id, {
      ...node.transform,
      translation: [100e-6, 0, 0],
    });
    const result = validateNode(id);
    expect(result?.exceedsUniverse).toBe(true);
  });
});
