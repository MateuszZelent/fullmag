/**
 * P1 — Geometry Builder Store
 *
 * Local interaction state for geometry authoring. The canonical source of truth
 * for production authoring is the backend SceneDocument.
 * Manages: draft graph state, dirty hints, builder mode, viewport tool,
 * universe constraints, and primitive CRUD for legacy/preview-only workflows.
 *
 * ADR: Store is domain-only — no rendering concerns.
 * UI components subscribe to narrow selectors.
 *
 * Dirty chain (P1):
 *   param/transform change -> geometryDraftDirty=true -> geometryRealizationDirty=true
 *                          -> meshDirty=true -> initialStateDirty=true -> resultsDirty=true
 *   visible change           -> no physics dirty
 *   enabled change           -> full dirty chain
 *   locked change            -> no physics dirty
 *   rename                   -> geometryRealizationDirty only (name goes to IR; mesh not affected)
 */

import { create } from "zustand";
import { nanoid } from "nanoid";

import type {
  GeometryGraphDocument,
  PrimitiveNode,
  PrimitiveKind,
  PrimitiveParams,
  GeometryNode,
  BooleanNode,
  BooleanOp,
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
  GeometryViewportTool,
  GeometrySnapSettings,
  Vec3,
} from "../model/types";
import { IDENTITY_TRANSFORM, CLEAN_STATE, PRIMITIVE_CAPABILITIES } from "../model/types";
import {
  createDefaultPrimitive,
  type DefaultPrimitiveContext,
} from "../model/defaults";
import { validatePlacement } from "../validation/placementValidation";

// ── Undo entry ────────────────────────────────────────────────

interface UndoEntry {
  nodes: GeometryNode[];
  graphRevision: number;
  description: string;
}

// ── Transform transaction ─────────────────────────────────────

/**
 * Active transform transaction: batches gizmo drag micro-updates into one undo entry.
 * Call `beginTransformTransaction` before drag, `commitTransformTransaction` on release.
 */
interface TransformTransaction {
  primitiveId: string;
  snapshotBeforeNodes: GeometryNode[];
  snapshotBeforeRevision: number;
  previewTransform: Transform3D;
}

interface BuilderCameraFocusRequest {
  kind: "selected" | "all";
  revision: number;
}

// ── Store state ───────────────────────────────────────────────

export interface GeometryBuilderState {
  // ── Core graph ─────────────────────────────────────────────
  graph: GeometryGraphDocument;
  dirty: DirtyState;
  revisions: RevisionChain;

  // ── Builder mode ───────────────────────────────────────────
  builderMode: GeometryBuilderMode;

  // ── Viewport tool ──────────────────────────────────────────
  viewportTool: GeometryViewportTool;
  snapSettings: GeometrySnapSettings;

  // ── Selection ──────────────────────────────────────────────
  builderSelection: BuilderSelectionTarget;

  // ── Constraint policy ──────────────────────────────────────
  constraintPolicy: UniverseConstraintPolicy;
  clipAcknowledged: boolean;

  // ── Realized snapshots ─────────────────────────────────────
  geometryRealization: GeometryRealizationSnapshot | null;
  meshSnapshot: MeshSnapshot | null;
  cameraFocusRequest: BuilderCameraFocusRequest | null;

  // ── Undo/Redo ──────────────────────────────────────────────
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  // ── Pending transform transaction ─────────────────────────
  activeTransformTransaction: TransformTransaction | null;

  // ── Actions: builder mode ──────────────────────────────────
  enableBuilder: () => void;
  disableBuilder: () => void;
  setSubmode: (submode: GeometryBuilderSubmode) => void;
  setViewportTool: (tool: GeometryViewportTool) => void;
  toggleSnap: () => void;

  // ── Actions: universe ──────────────────────────────────────
  setUniverseSize: (size: Vec3) => void;
  setUniverseOrigin: (origin: Vec3) => void;
  setUniverseVisibility: (visible: boolean) => void;
  setUniversePolicy: (policy: UniverseConstraintPolicy) => void;
  setClipAcknowledged: (acknowledged: boolean) => void;

  // ── Actions: primitive CRUD ────────────────────────────────
  addPrimitive: (kind: PrimitiveKind) => string;
  removePrimitive: (id: string) => void;
  duplicatePrimitive: (id: string) => string | null;
  renamePrimitive: (id: string, name: string) => void;
  setPrimitiveParams: (id: string, params: PrimitiveParams) => void;
  /**
   * Set transform directly (outside a transaction).
   * Pushes an undo entry. For drag operations, prefer transform transactions.
   */
  setPrimitiveTransform: (id: string, transform: Transform3D) => void;
  setPrimitiveVisible: (id: string, visible: boolean) => void;
  setPrimitiveEnabled: (id: string, enabled: boolean) => void;
  setPrimitiveLocked: (id: string, locked: boolean) => void;
  createBooleanFromEnabled: (op: BooleanOp) => string | null;

  // ── Actions: transform transactions ───────────────────────
  /**
   * Begin a drag transaction for a primitive. Saves a pre-drag snapshot for undo.
   * Subsequent `updateTransformPreview` calls do NOT push undo.
   */
  beginTransformTransaction: (id: string) => void;
  /**
   * Update the live preview transform during a drag. No undo is pushed.
   */
  updateTransformPreview: (id: string, transform: Transform3D) => void;
  /**
   * Commit the drag transaction: applies `transform` as the final value and
   * pushes one undo entry representing the whole drag.
   */
  commitTransformTransaction: (id: string, transform: Transform3D) => void;
  /**
   * Cancel the drag transaction: restores pre-drag state and discards undo.
   */
  cancelTransformTransaction: (id: string) => void;

  // ── Actions: selection ─────────────────────────────────────
  selectBuilderTarget: (target: BuilderSelectionTarget) => void;
  clearBuilderSelection: () => void;
  requestFocusSelected: () => void;
  requestFrameAll: () => void;

  // ── Actions: build lifecycle ───────────────────────────────
  buildGeometry: () => void;

  // ── Actions: universe utilities ───────────────────────────
  /**
   * Expand the Universe to fit all enabled primitives with an optional
   * per-axis padding fraction (default: 0.10 = 10 %).
   * No-op if there are no enabled primitives.
   */
  fitUniverseToObjects: (paddingFraction?: number) => void;
  /**
   * Reset the Universe to the default 1 µm³ cube centred at origin.
   */
  resetUniverseToDefault: () => void;

  // ── Actions: undo/redo ─────────────────────────────────────
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // ── Queries ────────────────────────────────────────────────
  getPrimitive: (id: string) => PrimitiveNode | null;
  getAllPrimitives: () => PrimitiveNode[];
  getUnsupportedPrimitivesForBackend: (isFemBackend: boolean) => PrimitiveNode[];
  getBackendBuildBlockedReason: (isFemBackend: boolean) => string | null;
  isRunBlocked: () => boolean;
  getGeometryBuildBlockedReason: () => string | null;
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
    policy: "preview_only_block_build",
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
  ellipsoid: 0,
  disk: 0,
  thin_film: 0,
  pillar: 0,
  nanowire: 0,
  ring: 0,
  triangular_prism: 0,
  cone: 0,
  capsule: 0,
  tube: 0,
  wedge: 0,
  polygon_prism: 0,
};

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
      clipAcknowledged: false,
    }));
  }

  function markRealizationDirty() {
    set((s) => ({
      dirty: {
        ...s.dirty,
        geometryRealizationDirty: true,
      },
      revisions: {
        ...s.revisions,
        geometryGraphRevision: s.revisions.geometryGraphRevision + 1,
      },
      clipAcknowledged: false,
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
    viewportTool: "camera",
    snapSettings: {
      enabled: false,
      translateStepMeters: 10e-9,
      rotateStepDeg: 5,
      scaleStep: 0.05,
    },
    builderSelection: { type: "none" },
    constraintPolicy: "preview_only_block_build",
    clipAcknowledged: false,
    geometryRealization: null,
    meshSnapshot: null,
    cameraFocusRequest: null,
    undoStack: [],
    redoStack: [],
    activeTransformTransaction: null,

    // ── Builder mode ─────────────────────────────────────────

    enableBuilder: () => set({ builderMode: { enabled: true, submode: "select" } }),
    disableBuilder: () => set({ builderMode: { enabled: false, submode: "select" } }),
    setSubmode: (submode) => set((s) => ({ builderMode: { ...s.builderMode, submode } })),
    setViewportTool: (tool) => set({ viewportTool: tool }),
    toggleSnap: () =>
      set((s) => ({
        snapSettings: { ...s.snapSettings, enabled: !s.snapSettings.enabled },
      })),

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

    setUniversePolicy: (policy) => {
      set((s) => ({
        graph: { ...s.graph, universe: { ...s.graph.universe, policy } },
        constraintPolicy: policy,
        clipAcknowledged: policy === "clip_with_explicit_ack" ? s.clipAcknowledged : false,
      }));
    },
    setClipAcknowledged: (acknowledged) => set({ clipAcknowledged: acknowledged }),

    // ── Primitive CRUD ───────────────────────────────────────

    addPrimitive: (kind) => {
      const state = get();
      const existingPrimitives = state.graph.nodes.filter(
        (n): n is PrimitiveNode => n.kind === "primitive",
      );
      const ctx: DefaultPrimitiveContext = {
        universe: state.graph.universe,
        existingPrimitives,
      };
      const node = createDefaultPrimitive(kind, ctx, nameCounters);

      pushUndo(`Add ${node.name}`);
      set((s) => ({
        graph: { ...s.graph, nodes: [...s.graph.nodes, node] },
        builderSelection: { type: "primitive", id: node.id },
      }));
      markGeometryDirty();
      return node.id;
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
      // Rename only dirties realization (name goes to IR region name), not mesh.
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, name } : n));
      markRealizationDirty();
    },

    setPrimitiveParams: (id, params) => {
      pushUndo("Edit primitive parameters");
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, params } : n));
      markGeometryDirty();
    },

    setPrimitiveTransform: (id, transform) => {
      // Direct (non-transaction) transform: push undo immediately.
      pushUndo("Transform primitive");
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, transform } : n));
      markGeometryDirty();
    },

    setPrimitiveVisible: (id, visible) => {
      // Visibility change: no physics dirty.
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, visible } : n));
    },

    setPrimitiveEnabled: (id, enabled) => {
      // Enabled change affects which bodies enter the solver → full dirty chain.
      pushUndo(enabled ? "Enable primitive" : "Disable primitive");
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, enabled } : n));
      markGeometryDirty();
    },

    setPrimitiveLocked: (id, locked) => {
      // Lock is editor-only, no physics dirty.
      updateNode(id, (n) => (n.kind === "primitive" ? { ...n, locked } : n));
    },

    createBooleanFromEnabled: (op) => {
      const primitives = get().graph.nodes.filter(
        (n): n is PrimitiveNode => n.kind === "primitive" && n.enabled,
      );
      if (primitives.length < 2) return null;
      const id = `bool-${nanoid(8)}`;
      const node: BooleanNode = {
        id,
        kind: "boolean",
        name: op === "union" ? "Union" : op === "subtract" ? "Subtract" : "Intersect",
        op,
        inputs: primitives.map((primitive) => primitive.id),
        enabled: true,
      };
      pushUndo(`Create ${node.name}`);
      set((s) => ({
        graph: { ...s.graph, nodes: [...s.graph.nodes, node] },
        builderSelection: { type: "boolean", id },
      }));
      markGeometryDirty();
      return id;
    },

    // ── Transform transactions ────────────────────────────────

    beginTransformTransaction: (id) => {
      const { graph, revisions } = get();
      set({
        activeTransformTransaction: {
          primitiveId: id,
          snapshotBeforeNodes: structuredClone(graph.nodes),
          snapshotBeforeRevision: revisions.geometryGraphRevision,
          previewTransform: (graph.nodes.find((n) => n.id === id) as PrimitiveNode | undefined)?.transform
            ?? IDENTITY_TRANSFORM,
        },
      });
    },

    updateTransformPreview: (id, transform) => {
      // Update live preview without dirtying or pushing undo.
      set((s) => ({
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) =>
            n.id === id && n.kind === "primitive" ? { ...n, transform } : n,
          ),
        },
        activeTransformTransaction: s.activeTransformTransaction
          ? { ...s.activeTransformTransaction, previewTransform: transform }
          : null,
      }));
    },

    commitTransformTransaction: (id, transform) => {
      const tx = get().activeTransformTransaction;
      if (!tx || tx.primitiveId !== id) {
        // No active transaction — fall back to direct setPrimitiveTransform semantics.
        get().setPrimitiveTransform(id, transform);
        return;
      }
      // Push one undo entry for the whole drag.
      set((s) => ({
        undoStack: [
          ...s.undoStack.slice(-49),
          {
            nodes: tx.snapshotBeforeNodes,
            graphRevision: tx.snapshotBeforeRevision,
            description: "Transform primitive",
          },
        ],
        redoStack: [],
        graph: {
          ...s.graph,
          nodes: s.graph.nodes.map((n) =>
            n.id === id && n.kind === "primitive" ? { ...n, transform } : n,
          ),
        },
        activeTransformTransaction: null,
      }));
      markGeometryDirty();
    },

    cancelTransformTransaction: (id) => {
      const tx = get().activeTransformTransaction;
      if (!tx || tx.primitiveId !== id) return;
      // Restore pre-drag snapshot.
      set((s) => ({
        graph: { ...s.graph, nodes: tx.snapshotBeforeNodes },
        revisions: { ...s.revisions, geometryGraphRevision: tx.snapshotBeforeRevision },
        activeTransformTransaction: null,
      }));
    },

    // ── Selection ────────────────────────────────────────────

    selectBuilderTarget: (target) => set({ builderSelection: target }),
    clearBuilderSelection: () => set({ builderSelection: { type: "none" } }),
    requestFocusSelected: () =>
      set((s) => ({
        cameraFocusRequest: {
          kind: "selected",
          revision: (s.cameraFocusRequest?.revision ?? 0) + 1,
        },
      })),
    requestFrameAll: () =>
      set((s) => ({
        cameraFocusRequest: {
          kind: "all",
          revision: (s.cameraFocusRequest?.revision ?? 0) + 1,
        },
      })),

    // ── Build lifecycle ──────────────────────────────────────

    buildGeometry: () => {
      const blockedReason = get().getGeometryBuildBlockedReason();
      if (blockedReason) {
        return;
      }
      const stateBeforeBuild = get();
      if (
        stateBeforeBuild.constraintPolicy === "auto_fit_universe" &&
        stateBeforeBuild.validateAll().some((v) => v.intersectsUniverseBoundary || v.exceedsUniverse)
      ) {
        stateBeforeBuild.fitUniverseToObjects();
      }

      const { graph, revisions } = get();
      const primitives = graph.nodes.filter(
        (n): n is PrimitiveNode => n.kind === "primitive" && n.enabled,
      );
      const booleans = graph.nodes.filter(
        (n): n is BooleanNode => n.kind === "boolean" && n.enabled,
      );

      const primitiveBodies = primitives.map((p) => ({
        sourceNodeId: p.id,
        name: p.name,
        boundsMin: computeBoundsMin(p),
        boundsMax: computeBoundsMax(p),
      }));
      const bodies = booleans.length > 0
        ? booleans.map((node) => {
            const inputs = primitiveBodies.filter((body) => node.inputs.includes(body.sourceNodeId));
            if (inputs.length === 0) {
              return {
                sourceNodeId: node.id,
                name: node.name,
                boundsMin: [0, 0, 0] as Vec3,
                boundsMax: [0, 0, 0] as Vec3,
              };
            }
            const min: Vec3 = [
              Math.min(...inputs.map((body) => body.boundsMin[0])),
              Math.min(...inputs.map((body) => body.boundsMin[1])),
              Math.min(...inputs.map((body) => body.boundsMin[2])),
            ];
            const max: Vec3 = [
              Math.max(...inputs.map((body) => body.boundsMax[0])),
              Math.max(...inputs.map((body) => body.boundsMax[1])),
              Math.max(...inputs.map((body) => body.boundsMax[2])),
            ];
            return {
              sourceNodeId: node.id,
              name: node.name,
              boundsMin: min,
              boundsMax: max,
            };
          })
        : primitiveBodies;

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

    fitUniverseToObjects: (paddingFraction = 0.10) => {
      const { graph } = get();
      const enabledPrims = graph.nodes.filter(
        (n): n is PrimitiveNode => n.kind === "primitive" && n.enabled,
      );
      if (enabledPrims.length === 0) return;

      const mins = enabledPrims.map(computeBoundsMin);
      const maxs = enabledPrims.map(computeBoundsMax);

      const mergedMin: Vec3 = [
        Math.min(...mins.map((m) => m[0])),
        Math.min(...mins.map((m) => m[1])),
        Math.min(...mins.map((m) => m[2])),
      ];
      const mergedMax: Vec3 = [
        Math.max(...maxs.map((m) => m[0])),
        Math.max(...maxs.map((m) => m[1])),
        Math.max(...maxs.map((m) => m[2])),
      ];

      const span: Vec3 = [
        mergedMax[0] - mergedMin[0],
        mergedMax[1] - mergedMin[1],
        mergedMax[2] - mergedMin[2],
      ];
      const padding: Vec3 = [
        Math.max(span[0] * paddingFraction, 1e-9),
        Math.max(span[1] * paddingFraction, 1e-9),
        Math.max(span[2] * paddingFraction, 1e-9),
      ];
      const newSize: Vec3 = [span[0] + 2 * padding[0], span[1] + 2 * padding[1], span[2] + 2 * padding[2]];
      const newOrigin: Vec3 = [
        (mergedMin[0] + mergedMax[0]) / 2,
        (mergedMin[1] + mergedMax[1]) / 2,
        (mergedMin[2] + mergedMax[2]) / 2,
      ];

      set((s) => ({
        graph: {
          ...s.graph,
          universe: { ...s.graph.universe, size: newSize, origin: newOrigin },
        },
        dirty: { ...s.dirty, geometryDraftDirty: true, geometryRealizationDirty: true, meshDirty: true },
        revisions: { ...s.revisions, geometryGraphRevision: s.revisions.geometryGraphRevision + 1 },
        clipAcknowledged: false,
      }));
    },

    resetUniverseToDefault: () => {
      set((s) => ({
        graph: {
          ...s.graph,
          universe: { ...s.graph.universe, size: [1e-6, 1e-6, 1e-6], origin: [0, 0, 0] },
        },
        dirty: { ...s.dirty, geometryDraftDirty: true, geometryRealizationDirty: true, meshDirty: true },
        revisions: { ...s.revisions, geometryGraphRevision: s.revisions.geometryGraphRevision + 1 },
        clipAcknowledged: false,
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

    getUnsupportedPrimitivesForBackend: (isFemBackend) => {
      return get().graph.nodes.filter((node): node is PrimitiveNode => {
        if (node.kind !== "primitive" || !node.enabled) {
          return false;
        }
        const capability = PRIMITIVE_CAPABILITIES[node.primitiveKind];
        return isFemBackend ? !capability.fem : !capability.fdm;
      });
    },

    getBackendBuildBlockedReason: (isFemBackend) => {
      const unsupported = get().getUnsupportedPrimitivesForBackend(isFemBackend);
      if (unsupported.length === 0) {
        return null;
      }
      const backendLabel = isFemBackend ? "FEM mesh" : "FDM grid";
      const labels = unsupported
        .slice(0, 3)
        .map((node) => PRIMITIVE_CAPABILITIES[node.primitiveKind].label)
        .join(", ");
      const suffix = unsupported.length > 3 ? ` and ${unsupported.length - 3} more` : "";
      return `${backendLabel} build blocked: ${labels}${suffix} ${unsupported.length === 1 ? "is" : "are"} preview-only for the active backend.`;
    },

    isRunBlocked: () => {
      const { dirty, getGeometryBuildBlockedReason } = get();
      if (!dirty.geometryDraftDirty && !dirty.geometryRealizationDirty) {
        return false;
      }
      return getGeometryBuildBlockedReason() !== null;
    },

    getGeometryBuildBlockedReason: () => {
      const { graph, constraintPolicy, clipAcknowledged } = get();
      const enabledPrimitives = graph.nodes.filter(
        (n): n is PrimitiveNode => n.kind === "primitive" && n.enabled,
      );
      if (enabledPrimitives.length === 0) {
        return "No enabled primitives. Add or enable an object before Build Geometry.";
      }
      const validations = enabledPrimitives.map((primitive) =>
        validatePlacement(primitive, graph.universe),
      );
      const hasSelfInvalid = validations.some((v) => v.selfInvalid);
      if (hasSelfInvalid) {
        return "Fix validation errors before Build Geometry.";
      }
      const hasBoundaryIssues = validations.some(
        (v) => v.intersectsUniverseBoundary || v.exceedsUniverse,
      );
      if (!hasBoundaryIssues) {
        return null;
      }
      if (constraintPolicy === "auto_fit_universe") {
        return null;
      }
      if (constraintPolicy === "clip_with_explicit_ack") {
        if (!clipAcknowledged) {
          return "Clipping changes solver geometry. Confirm clipping in Universe inspector before Build Geometry.";
        }
        return null;
      }
      if (constraintPolicy === "preview_only_block_build") {
        return "Objects exceed Universe bounds. Fit Universe, move objects, or switch policy before Build Geometry.";
      }
      return "Build Geometry blocked by Universe policy. Resolve out-of-bounds objects first.";
    },

    getRunBlockedReason: () => {
      const { dirty, getGeometryBuildBlockedReason } = get();
      if (dirty.geometryDraftDirty || dirty.geometryRealizationDirty) {
        const geometryBuildBlockedReason = getGeometryBuildBlockedReason();
        if (geometryBuildBlockedReason) return geometryBuildBlockedReason;
      }
      return null;
    },

    validateNode: (id) => {
      const state = get();
      const node = state.graph.nodes.find((n) => n.id === id);
      if (!node || node.kind !== "primitive") {
        return { withinUniverse: true, intersectsUniverseBoundary: false, exceedsUniverse: false, selfInvalid: false, diagnostics: [], suggestedActions: [] };
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
    case "thin_film":
    case "nanowire":
    case "wedge":
      return [
        (p.params.data.size[0] / 2) * sx,
        (p.params.data.size[1] / 2) * sy,
        (p.params.data.size[2] / 2) * sz,
      ];
    case "cylinder":
    case "pillar": {
      const { radius, height, axis } = p.params.data;
      if (axis === "x") return [(height / 2) * sx, radius * sy, radius * sz];
      if (axis === "y") return [radius * sx, (height / 2) * sy, radius * sz];
      return [radius * sx, radius * sy, (height / 2) * sz];
    }
    case "sphere": {
      const r = p.params.data.radius;
      return [r * sx, r * sy, r * sz];
    }
    case "ellipsoid":
      return [
        p.params.data.radii[0] * sx,
        p.params.data.radii[1] * sy,
        p.params.data.radii[2] * sz,
      ];
    case "disk": {
      const { radius, thickness, axis } = p.params.data;
      if (axis === "x") return [(thickness / 2) * sx, radius * sy, radius * sz];
      if (axis === "y") return [radius * sx, (thickness / 2) * sy, radius * sz];
      return [radius * sx, radius * sy, (thickness / 2) * sz];
    }
    case "ring":
    case "tube": {
      const { outerRadius, height, axis } = p.params.data;
      if (axis === "x") return [(height / 2) * sx, outerRadius * sy, outerRadius * sz];
      if (axis === "y") return [outerRadius * sx, (height / 2) * sy, outerRadius * sz];
      return [outerRadius * sx, outerRadius * sy, (height / 2) * sz];
    }
    case "triangular_prism": {
      const { base, triangleHeight, depth, axis } = p.params.data;
      if (axis === "x") return [(depth / 2) * sx, (base / 2) * sy, (triangleHeight / 2) * sz];
      if (axis === "y") return [(base / 2) * sx, (depth / 2) * sy, (triangleHeight / 2) * sz];
      return [(base / 2) * sx, (triangleHeight / 2) * sy, (depth / 2) * sz];
    }
    case "cone":
    case "capsule": {
      const radius = p.params.kind === "cone"
        ? Math.max(p.params.data.radiusTop, p.params.data.radiusBottom)
        : p.params.data.radius;
      const { height, axis } = p.params.data;
      if (axis === "x") return [(height / 2) * sx, radius * sy, radius * sz];
      if (axis === "y") return [radius * sx, (height / 2) * sy, radius * sz];
      return [radius * sx, radius * sy, (height / 2) * sz];
    }
    case "polygon_prism": {
      const { radius, depth, axis } = p.params.data;
      if (axis === "x") return [(depth / 2) * sx, radius * sy, radius * sz];
      if (axis === "y") return [radius * sx, (depth / 2) * sy, radius * sz];
      return [radius * sx, radius * sy, (depth / 2) * sz];
    }
  }
}
