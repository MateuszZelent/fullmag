/**
 * P1 — Geometry Builder Store
 *
 * Single source of truth for geometry authoring state.
 * Manages: geometry graph, dirty state, revision chain,
 * builder mode, universe constraints, and primitive CRUD.
 *
 * ADR: Store is domain-only — no rendering concerns.
 * UI components subscribe to narrow selectors.
 */

import { create } from "zustand";
import { nanoid } from "nanoid";

import type {
  GeometryGraphDocument,
  PrimitiveNode,
  PrimitiveKind,
  PrimitiveParams,
  BooleanNode,
  GeometryNode,
  UniverseNode,
  Transform3D,
  DirtyState,
  RevisionChain,
  GeometryBuilderMode,
  GeometryBuilderSubmode,
  GeometryRealizationSnapshot,
  MeshSnapshot,
  PlacementValidation,
  UniverseConstraintPolicy,
  BuilderSelectionTarget,
  Vec3,
} from "../model/types";
import { IDENTITY_TRANSFORM, CLEAN_STATE } from "../model/types";
import { defaultPrimitiveParams } from "../model/defaults";
import { validatePlacement } from "../validation/placementValidation";

// ── Undo entry ────────────────────────────────────────────────

interface UndoEntry {
  nodes: GeometryNode[];
  graphRevision: number;
  description: string;
}

// ── Store state ───────────────────────────────────────────────

export interface GeometryBuilderState {
  // ── Core graph ─────────────────────────────────────────────
  graph: GeometryGraphDocument;
  dirty: DirtyState;
  revisions: RevisionChain;

  // ── Builder mode ───────────────────────────────────────────
  builderMode: GeometryBuilderMode;

  // ── Selection ──────────────────────────────────────────────
  builderSelection: BuilderSelectionTarget;

  // ── Constraint policy ──────────────────────────────────────
  constraintPolicy: UniverseConstraintPolicy;

  // ── Realized snapshots ─────────────────────────────────────
  geometryRealization: GeometryRealizationSnapshot | null;
  meshSnapshot: MeshSnapshot | null;

  // ── Undo/Redo ──────────────────────────────────────────────
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  // ── Actions: builder mode ──────────────────────────────────
  enableBuilder: () => void;
  disableBuilder: () => void;
  setSubmode: (submode: GeometryBuilderSubmode) => void;

  // ── Actions: universe ──────────────────────────────────────
  setUniverseSize: (size: Vec3) => void;
  setUniverseOrigin: (origin: Vec3) => void;
  setUniverseVisibility: (visible: boolean) => void;

  // ── Actions: primitive CRUD ────────────────────────────────
  addPrimitive: (kind: PrimitiveKind) => string;
  removePrimitive: (id: string) => void;
  duplicatePrimitive: (id: string) => string | null;
  renamePrimitive: (id: string, name: string) => void;
  setPrimitiveParams: (id: string, params: PrimitiveParams) => void;
  setPrimitiveTransform: (id: string, transform: Transform3D) => void;
  setPrimitiveVisible: (id: string, visible: boolean) => void;
  setPrimitiveEnabled: (id: string, enabled: boolean) => void;
  setPrimitiveLocked: (id: string, locked: boolean) => void;

  // ── Actions: selection ─────────────────────────────────────
  selectBuilderTarget: (target: BuilderSelectionTarget) => void;
  clearBuilderSelection: () => void;

  // ── Actions: build lifecycle ───────────────────────────────
  buildGeometry: () => void;
  buildMesh: () => void;

  // ── Actions: undo/redo ─────────────────────────────────────
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // ── Queries ────────────────────────────────────────────────
  getPrimitive: (id: string) => PrimitiveNode | null;
  getAllPrimitives: () => PrimitiveNode[];
  isRunBlocked: () => boolean;
  getRunBlockedReason: () => string | null;
  validateNode: (id: string) => PlacementValidation;
  validateAll: () => PlacementValidation[];
}

// ── Default universe ──────────────────────────────────────────

function createDefaultUniverse(): UniverseNode {
  return {
    id: "universe",
    kind: "universe",
    boundsMode: "box",
    size: [1e-6, 1e-6, 1e-6],
    origin: [0, 0, 0],
    visibility: true,
    lockTransforms: true,
  };
}

function createDefaultGraph(): GeometryGraphDocument {
  return {
    version: "geometry_graph.v1",
    universe: createDefaultUniverse(),
    nodes: [],
  };
}

// ── Primitive name counter ────────────────────────────────────

const nameCounters: Record<PrimitiveKind, number> = {
  box: 0,
  cylinder: 0,
  sphere: 0,
  disk: 0,
  triangular_prism: 0,
};

const PRIMITIVE_DISPLAY_NAMES: Record<PrimitiveKind, string> = {
  box: "Box",
  cylinder: "Cylinder",
  sphere: "Sphere",
  disk: "Disk",
  triangular_prism: "Triangle",
};

function nextPrimitiveName(kind: PrimitiveKind): string {
  nameCounters[kind] += 1;
  return `${PRIMITIVE_DISPLAY_NAMES[kind]} ${String(nameCounters[kind]).padStart(3, "0")}`;
}

// ── Store ─────────────────────────────────────────────────────

export const useGeometryBuilderStore = create<GeometryBuilderState>((set, get) => {
  // ── Helpers ────────────────────────────────────────────────

  function pushUndo(description: string) {
    const { graph, revisions } = get();
    set((s) => ({
      undoStack: [
        ...s.undoStack.slice(-49), // keep last 50 entries
        { nodes: structuredClone(graph.nodes), graphRevision: revisions.geometryGraphRevision, description },
      ],
      redoStack: [],
    }));
  }

  function markGeometryDirty() {
    set((s) => ({
      dirty: {
        ...s.dirty,
        geometryDraftDirty: true,
        geometryRealizationDirty: true,
        meshDirty: true,
        initialStateDirty: true,
        resultsDirty: true,
      },
      revisions: {
        ...s.revisions,
        geometryGraphRevision: s.revisions.geometryGraphRevision + 1,
      },
    }));
  }

  function updateNode(id: string, updater: (node: GeometryNode) => GeometryNode) {
    set((s) => ({
      graph: {
        ...s.graph,
        nodes: s.graph.nodes.map((n) => (n.id === id ? updater(n) : n)),
      },
    }));
  }

  return {
    // ── Initial state ────────────────────────────────────────
    graph: createDefaultGraph(),
    dirty: CLEAN_STATE,
    revisions: { geometryGraphRevision: 0, geometryRealizationRevision: null, meshRevision: null },
    builderMode: { enabled: false, submode: "select" },
    builderSelection: { type: "none" },
    constraintPolicy: "preview_only_block_commit",
    geometryRealization: null,
    meshSnapshot: null,
    undoStack: [],
    redoStack: [],

    // ── Builder mode ─────────────────────────────────────────

    enableBuilder: () => set({ builderMode: { enabled: true, submode: "select" } }),
    disableBuilder: () => set({ builderMode: { enabled: false, submode: "select" } }),
    setSubmode: (submode) => set((s) => ({ builderMode: { ...s.builderMode, submode } })),

    // ── Universe ─────────────────────────────────────────────

    setUniverseSize: (size) => {
      pushUndo("Change universe size");
      set((s) => ({
        graph: { ...s.graph, universe: { ...s.graph.universe, size } },
      }));
      markGeometryDirty();
    },

    setUniverseOrigin: (origin) => {
      pushUndo("Change universe origin");
      set((s) => ({
        graph: { ...s.graph, universe: { ...s.graph.universe, origin } },
      }));
      markGeometryDirty();
    },

    setUniverseVisibility: (visible) => {
      set((s) => ({
        graph: { ...s.graph, universe: { ...s.graph.universe, visibility: visible } },
      }));
    },

    // ── Primitive CRUD ───────────────────────────────────────

    addPrimitive: (kind) => {
      const id = `prim-${nanoid(8)}`;
      const universeSize = get().graph.universe.size;
      const params = defaultPrimitiveParams(kind, universeSize);
      const name = nextPrimitiveName(kind);

      const node: PrimitiveNode = {
        id,
        kind: "primitive",
        primitiveKind: kind,
        name,
        enabled: true,
        visible: true,
        locked: false,
        transform: { ...IDENTITY_TRANSFORM },
        params,
        materialBindingId: null,
        tags: [],
      };

      pushUndo(`Add ${name}`);
      set((s) => ({
        graph: { ...s.graph, nodes: [...s.graph.nodes, node] },
        builderSelection: { type: "primitive", id },
      }));
      markGeometryDirty();
      return id;
    },

    removePrimitive: (id) => {
      const node = get().graph.nodes.find((n) => n.id === id);
      if (!node) return;
      pushUndo(`Delete ${node.kind === "primitive" ? (node as PrimitiveNode).name : id}`);
      set((s) => ({
        graph: { ...s.graph, nodes: s.graph.nodes.filter((n) => n.id !== id) },
        builderSelection: s.builderSelection.type !== "none" && "id" in s.builderSelection && s.builderSelection.id === id
          ? { type: "none" }
          : s.builderSelection,
      }));
      markGeometryDirty();
    },

    duplicatePrimitive: (id) => {
      const source = get().graph.nodes.find((n) => n.id === id && n.kind === "primitive") as PrimitiveNode | undefined;
      if (!source) return null;
      const newId = `prim-${nanoid(8)}`;
      const newName = `${source.name} (copy)`;
      const clone: PrimitiveNode = {
        ...structuredClone(source),
        id: newId,
        name: newName,
      };
      pushUndo(`Duplicate ${source.name}`);
      set((s) => ({
        graph: { ...s.graph, nodes: [...s.graph.nodes, clone] },
        builderSelection: { type: "primitive", id: newId },
      }));
      markGeometryDirty();
      return newId;
    },

    renamePrimitive: (id, name) => {
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, name } : n));
    },

    setPrimitiveParams: (id, params) => {
      pushUndo("Edit primitive parameters");
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, params } : n));
      markGeometryDirty();
    },

    setPrimitiveTransform: (id, transform) => {
      pushUndo("Transform primitive");
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, transform } : n));
      markGeometryDirty();
    },

    setPrimitiveVisible: (id, visible) => {
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, visible } : n));
    },

    setPrimitiveEnabled: (id, enabled) => {
      pushUndo(enabled ? "Enable primitive" : "Disable primitive");
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, enabled } : n));
      markGeometryDirty();
    },

    setPrimitiveLocked: (id, locked) => {
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, locked } : n));
    },

    // ── Selection ────────────────────────────────────────────

    selectBuilderTarget: (target) => set({ builderSelection: target }),
    clearBuilderSelection: () => set({ builderSelection: { type: "none" } }),

    // ── Build lifecycle ──────────────────────────────────────

    buildGeometry: () => {
      const { graph, revisions } = get();
      const primitives = graph.nodes.filter(
        (n): n is PrimitiveNode => n.kind === "primitive" && n.enabled,
      );

      const bodies = primitives.map((p) => ({
        sourceNodeId: p.id,
        name: p.name,
        boundsMin: computeBoundsMin(p),
        boundsMax: computeBoundsMax(p),
      }));

      const allMins = bodies.map((b) => b.boundsMin);
      const allMaxs = bodies.map((b) => b.boundsMax);

      const snapshot: GeometryRealizationSnapshot = {
        revision: (revisions.geometryRealizationRevision ?? 0) + 1,
        sourceGraphRevision: revisions.geometryGraphRevision,
        bodies,
        boundsMin: allMins.length > 0
          ? [Math.min(...allMins.map((m) => m[0])), Math.min(...allMins.map((m) => m[1])), Math.min(...allMins.map((m) => m[2]))]
          : [0, 0, 0],
        boundsMax: allMaxs.length > 0
          ? [Math.max(...allMaxs.map((m) => m[0])), Math.max(...allMaxs.map((m) => m[1])), Math.max(...allMaxs.map((m) => m[2]))]
          : [0, 0, 0],
        createdAt: new Date().toISOString(),
      };

      set((s) => ({
        geometryRealization: snapshot,
        dirty: {
          ...s.dirty,
          geometryDraftDirty: false,
          geometryRealizationDirty: false,
        },
        revisions: {
          ...s.revisions,
          geometryRealizationRevision: snapshot.revision,
        },
      }));
    },

    buildMesh: () => {
      const { geometryRealization, revisions } = get();
      if (!geometryRealization) return;

      const snapshot: MeshSnapshot = {
        revision: (revisions.meshRevision ?? 0) + 1,
        sourceGeometryRevision: geometryRealization.revision,
        meshState: "ready",
        qualitySummary: null,
        createdAt: new Date().toISOString(),
      };

      set((s) => ({
        meshSnapshot: snapshot,
        dirty: {
          ...s.dirty,
          meshDirty: false,
          initialStateDirty: false,
        },
        revisions: {
          ...s.revisions,
          meshRevision: snapshot.revision,
        },
      }));
    },

    // ── Undo / Redo ──────────────────────────────────────────

    undo: () => {
      const { undoStack, graph, revisions } = get();
      if (undoStack.length === 0) return;
      const entry = undoStack[undoStack.length - 1];

      set((s) => ({
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [
          ...s.redoStack,
          { nodes: structuredClone(graph.nodes), graphRevision: revisions.geometryGraphRevision, description: "redo" },
        ],
        graph: { ...s.graph, nodes: structuredClone(entry.nodes) },
        revisions: { ...s.revisions, geometryGraphRevision: entry.graphRevision },
        dirty: {
          ...s.dirty,
          geometryDraftDirty: true,
          geometryRealizationDirty: true,
          meshDirty: true,
        },
      }));
    },

    redo: () => {
      const { redoStack, graph, revisions } = get();
      if (redoStack.length === 0) return;
      const entry = redoStack[redoStack.length - 1];

      set((s) => ({
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [
          ...s.undoStack,
          { nodes: structuredClone(graph.nodes), graphRevision: revisions.geometryGraphRevision, description: "undo" },
        ],
        graph: { ...s.graph, nodes: structuredClone(entry.nodes) },
        revisions: { ...s.revisions, geometryGraphRevision: entry.graphRevision },
        dirty: {
          ...s.dirty,
          geometryDraftDirty: true,
          geometryRealizationDirty: true,
          meshDirty: true,
        },
      }));
    },

    canUndo: () => get().undoStack.length > 0,
    canRedo: () => get().redoStack.length > 0,

    // ── Queries ──────────────────────────────────────────────

    getPrimitive: (id) => {
      const node = get().graph.nodes.find((n) => n.id === id);
      return node?.kind === "primitive" ? (node as PrimitiveNode) : null;
    },

    getAllPrimitives: () => {
      return get().graph.nodes.filter((n): n is PrimitiveNode => n.kind === "primitive");
    },

    isRunBlocked: () => {
      const { dirty, meshSnapshot, geometryRealization } = get();
      return dirty.meshDirty || !meshSnapshot || !geometryRealization;
    },

    getRunBlockedReason: () => {
      const { dirty, meshSnapshot, geometryRealization } = get();
      if (!geometryRealization) return "Geometry not built. Click Build Geometry first.";
      if (dirty.geometryRealizationDirty) return "Geometry changed since last build. Rebuild geometry first.";
      if (!meshSnapshot) return "Mesh not built. Click Build Mesh first.";
      if (dirty.meshDirty) return "Mesh out of date. Rebuild mesh first.";
      return null;
    },

    validateNode: (id) => {
      const state = get();
      const node = state.graph.nodes.find((n) => n.id === id);
      if (!node || node.kind !== "primitive") {
        return { withinUniverse: true, intersectsUniverseBoundary: false, exceedsUniverse: false, selfInvalid: false, diagnostics: [] };
      }
      return validatePlacement(node as PrimitiveNode, state.graph.universe);
    },

    validateAll: () => {
      const state = get();
      return state.graph.nodes
        .filter((n): n is PrimitiveNode => n.kind === "primitive")
        .map((p) => validatePlacement(p, state.graph.universe));
    },
  };
});

// ── Bounds computation helpers ────────────────────────────────

function computeBoundsMin(p: PrimitiveNode): Vec3 {
  const [tx, ty, tz] = p.transform.translation;
  const halfExtent = computeHalfExtent(p);
  return [tx - halfExtent[0], ty - halfExtent[1], tz - halfExtent[2]];
}

function computeBoundsMax(p: PrimitiveNode): Vec3 {
  const [tx, ty, tz] = p.transform.translation;
  const halfExtent = computeHalfExtent(p);
  return [tx + halfExtent[0], ty + halfExtent[1], tz + halfExtent[2]];
}

function computeHalfExtent(p: PrimitiveNode): Vec3 {
  const [sx, sy, sz] = p.transform.scale;
  switch (p.params.kind) {
    case "box":
      return [
        (p.params.data.size[0] / 2) * sx,
        (p.params.data.size[1] / 2) * sy,
        (p.params.data.size[2] / 2) * sz,
      ];
    case "cylinder": {
      const { radius, height, axis } = p.params.data;
      if (axis === "x") return [(height / 2) * sx, radius * sy, radius * sz];
      if (axis === "y") return [radius * sx, (height / 2) * sy, radius * sz];
      return [radius * sx, radius * sy, (height / 2) * sz];
    }
    case "sphere": {
      const r = p.params.data.radius;
      return [r * sx, r * sy, r * sz];
    }
    case "disk": {
      const { radius, thickness, axis } = p.params.data;
      if (axis === "x") return [(thickness / 2) * sx, radius * sy, radius * sz];
      if (axis === "y") return [radius * sx, (thickness / 2) * sy, radius * sz];
      return [radius * sx, radius * sy, (thickness / 2) * sz];
    }
    case "triangular_prism": {
      const { base, triangleHeight, depth, axis } = p.params.data;
      if (axis === "x") return [(depth / 2) * sx, (base / 2) * sy, (triangleHeight / 2) * sz];
      if (axis === "y") return [(base / 2) * sx, (depth / 2) * sy, (triangleHeight / 2) * sz];
      return [(base / 2) * sx, (triangleHeight / 2) * sy, (depth / 2) * sz];
    }
  }
}
