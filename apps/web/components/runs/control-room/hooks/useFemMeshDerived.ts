import { useEffect, useMemo, useRef } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  FemMeshPart,
  MeshEntityViewStateMap,
  ScriptBuilderGeometryEntry,
} from "../../../../lib/session/types";
import { defaultMeshEntityViewState } from "../../../../lib/session/types";
import type {
  FemColorField,
  FemMeshData,
  MeshSelectionSnapshot,
  RenderMode,
} from "@/components/preview/FemMeshView3D";
import type {
  BuilderObjectOverlay,
  FemDockTab,
  SlicePlane,
  VectorComponent,
} from "../shared";
import {
  FEM_SLICE_COUNT,
  buildObjectOverlays,
  computeMeshFaceDetail,
  type ViewportMode,
} from "../shared";
import {
  deriveMeshBuildRuntimeState,
  deriveMeshWorkspacePreset,
  type MeshWorkspacePresetId,
} from "../meshWorkspace";
import { latestBackendErrorFromLog } from "../helpers";
import type {
  BackendErrorInfo,
  FieldStats,
  MaterialSummary,
  MeshQualitySummary,
  SessionFooterData,
} from "../types";
import type { EngineLogEntry } from "@/lib/session/types";
import {
  resolveArrowVisibility,
  type ArrowVisibilityStatus,
} from "../../../../features/viewport-fem/model/femArrowVisibility";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "../../../../lib/debug/frontendDiagnosticFlags";
import type { CapabilityMap } from "@/src/api/types";
import { isFemDiscretization } from "@/src/domain/capabilities";

function flattenTriples(values: ArrayLike<ArrayLike<number>>): number[] {
  const flat = new Array(values.length * 3);
  let offset = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    flat[offset] = Number(value?.[0] ?? 0);
    flat[offset + 1] = Number(value?.[1] ?? 0);
    flat[offset + 2] = Number(value?.[2] ?? 0);
    offset += 3;
  }
  return flat;
}

function flattenQuads(values: ArrayLike<ArrayLike<number>>): number[] {
  const flat = new Array(values.length * 4);
  let offset = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    flat[offset] = Number(value?.[0] ?? 0);
    flat[offset + 1] = Number(value?.[1] ?? 0);
    flat[offset + 2] = Number(value?.[2] ?? 0);
    flat[offset + 3] = Number(value?.[3] ?? 0);
    offset += 4;
  }
  return flat;
}

function resolveFemTopologyCacheKey(mesh: any): string | null {
  if (!mesh) {
    return null;
  }
  const generationId = mesh.generation_id ?? mesh.mesh_id ?? null;
  if (typeof generationId === "string" && generationId.length > 0) {
    return `gen:${generationId}`;
  }
  const nodeCount = mesh.node_count ?? mesh.nodes?.length ?? 0;
  const elementCount = mesh.element_count ?? mesh.elements?.length ?? 0;
  const boundaryFaceCount = mesh.boundary_face_count ?? mesh.boundary_faces?.length ?? 0;
  const firstNode = mesh.nodes?.[0]?.join(",") ?? "";
  const middleNode = mesh.nodes?.[Math.floor((mesh.nodes?.length ?? 0) / 2)]?.join(",") ?? "";
  const lastNode = mesh.nodes?.[(mesh.nodes?.length ?? 1) - 1]?.join(",") ?? "";
  const firstElement = mesh.elements?.[0]?.join(",") ?? "";
  return [
    "derived",
    nodeCount,
    elementCount,
    boundaryFaceCount,
    firstNode,
    middleNode,
    lastNode,
    firstElement,
  ].join(":");
}

function hasBinaryTopologyBuffers(mesh: any): boolean {
  const topologyBuffers = mesh?.topology_buffers;
  if (!topologyBuffers) {
    return false;
  }
  return (
    topologyBuffers.nodes instanceof Float64Array &&
    topologyBuffers.elements instanceof Uint32Array &&
    topologyBuffers.boundary_faces instanceof Uint32Array &&
    topologyBuffers.nodes.length > 0 &&
    topologyBuffers.elements.length > 0 &&
    topologyBuffers.boundary_faces.length > 0
  );
}

function hasInlineTopologyArrays(mesh: any): boolean {
  if (!mesh) {
    return false;
  }
  const nodeCount = mesh.node_count ?? mesh.nodes?.length ?? 0;
  const elementCount = mesh.element_count ?? mesh.elements?.length ?? 0;
  const boundaryFaceCount = mesh.boundary_face_count ?? mesh.boundary_faces?.length ?? 0;
  const isExplicitlyEmpty =
    nodeCount === 0 &&
    elementCount === 0 &&
    boundaryFaceCount === 0;
  if (isExplicitlyEmpty) {
    return true;
  }
  return (
    Array.isArray(mesh.nodes) &&
    Array.isArray(mesh.elements) &&
    Array.isArray(mesh.boundary_faces) &&
    mesh.nodes.length > 0 &&
    mesh.elements.length > 0 &&
    mesh.boundary_faces.length > 0
  );
}

function topologySnapshotKey(mesh: any, topologyKey: string): string {
  const topologyBuffers = mesh?.topology_buffers;
  return [
    topologyKey,
    topologyBuffers ? "binary" : "json",
    topologyBuffers?.nodes?.length ?? mesh?.nodes?.length ?? 0,
    topologyBuffers?.elements?.length ?? (mesh?.elements?.length ?? 0) * 4,
    topologyBuffers?.boundary_faces?.length ?? (mesh?.boundary_faces?.length ?? 0) * 3,
  ].join(":");
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface UseFemMeshDerivedParams {
  isMeshPreview: boolean;
  renderPreview: any;
  femMesh: any;
  meshEntityViewState: MeshEntityViewStateMap;
  selectedEntityId: string | null;
  focusedEntityId: string | null;
  scriptBuilderGeometries: ScriptBuilderGeometryEntry[] | null;
  selectedVectors: Float64Array | number[] | null;
  selectedFieldNComp: number;
  selectedFieldDomain: "magnetic_only" | "full_domain" | "surface_only" | null;
  fieldDataRevision?: number | string | null;
  activeMask: boolean[] | null;
  spatialPreview: any;
  meshShowArrows: boolean;
  effectiveViewMode: ViewportMode;
  activeQuantityId: string;
  isFemBackend: boolean;
  domainCapabilities?: CapabilityMap | null;
  meshGenerating: boolean;
  commandStatus: any;
  meshSummary: any;
  meshWorkspace: any;
  selectedSidebarNodeId: string | null;
  selectedObjectId: string | null;
  airMeshVisible: boolean;
  airMeshOpacity: number;
  effectiveVectorComponent: VectorComponent;
  sliceIndex: number;
  plane: SlicePlane;
  previewGrid: [number, number, number];
  solverPlan: any;
  workspaceStatus: string;
  latestEngineMessage: string | null;
  session: any;
  engineLog: EngineLogEntry[];
  frontendTraceLog: EngineLogEntry[];
  meshRenderMode: RenderMode;
  femDockTab: FemDockTab;
  meshConfigSignature: string | null;
  lastBuiltMeshConfigSignature: string | null;
  meshSelection: MeshSelectionSnapshot;
  femFieldBuffersRef: MutableRefObject<{ nNodes: number; x: Float64Array; y: Float64Array; z: Float64Array } | null>;
  femMeshDataRef: MutableRefObject<FemMeshData | null>;
  femTopologyKeyRef: MutableRefObject<string | null>;
  femGenerationIdRef: MutableRefObject<string | null>;
  meshGenTopologyRef: MutableRefObject<string | null>;
  meshGenGenerationRef: MutableRefObject<string | null>;
  pendingMeshConfigSignatureRef: MutableRefObject<string | null>;
  meshConfigSignatureRef: MutableRefObject<string | null>;
  setMeshEntityViewState: Dispatch<SetStateAction<MeshEntityViewStateMap>>;
  setSelectedEntityId: Dispatch<SetStateAction<string | null>>;
  setFocusedEntityId: Dispatch<SetStateAction<string | null>>;
  setMeshGenerating: Dispatch<SetStateAction<boolean>>;
  setLastBuiltMeshConfigSignature: Dispatch<SetStateAction<string | null>>;
  setSliceIndex: Dispatch<SetStateAction<number>>;
  setMeshSelection: Dispatch<SetStateAction<MeshSelectionSnapshot>>;
  appendFrontendTrace: (level: string, message: string) => void;
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface UseFemMeshDerivedReturn {
  effectiveFemMesh: any;
  meshParts: FemMeshPart[];
  magneticParts: FemMeshPart[];
  airPart: FemMeshPart | null;
  airRelatedParts: FemMeshPart[];
  interfaceParts: FemMeshPart[];
  visibleMeshPartIds: string[];
  visibleMagneticObjectIds: string[];
  selectedMeshPart: FemMeshPart | null;
  focusedMeshPart: FemMeshPart | null;
  objectOverlays: BuilderObjectOverlay[];
  femMeshData: FemMeshData | null;
  femHasFieldData: boolean;
  femMagnetization3DActive: boolean;
  femShouldShowArrows: boolean;
  arrowVisibility: ArrowVisibilityStatus;
  femTopologyKey: string | null;
  femColorField: FemColorField;
  isMeshWorkspaceView: boolean;
  meshWorkspacePreset: MeshWorkspacePresetId;
  meshConfigDirty: boolean;
  meshFaceDetail: ReturnType<typeof computeMeshFaceDetail>;
  meshQualitySummary: MeshQualitySummary | null;
  maxSliceCount: number;
  fieldStats: FieldStats | null;
  material: MaterialSummary | null;
  emptyStateMessage: { title: string; description: string };
  sessionFooter: SessionFooterData;
  latestBackendError: BackendErrorInfo | null;
  mergedEngineLog: EngineLogEntry[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFemMeshDerived(params: UseFemMeshDerivedParams): UseFemMeshDerivedReturn {
  const {
    isMeshPreview,
    renderPreview,
    femMesh,
    meshEntityViewState,
    selectedEntityId,
    focusedEntityId,
    scriptBuilderGeometries,
    selectedVectors,
    selectedFieldNComp,
    selectedFieldDomain,
    fieldDataRevision = null,
    activeMask,
    spatialPreview,
    meshShowArrows,
    effectiveViewMode,
    activeQuantityId,
    isFemBackend,
    domainCapabilities,
    meshGenerating,
    commandStatus,
    meshSummary,
    meshWorkspace,
    selectedSidebarNodeId,
    selectedObjectId,
    airMeshVisible,
    airMeshOpacity,
    effectiveVectorComponent,
    sliceIndex,
    plane,
    previewGrid,
    solverPlan,
    workspaceStatus,
    latestEngineMessage,
    session,
    engineLog,
    frontendTraceLog,
    meshRenderMode,
    femDockTab,
    meshConfigSignature,
    lastBuiltMeshConfigSignature,
    meshSelection,
    femFieldBuffersRef,
    femMeshDataRef,
    femTopologyKeyRef,
    femGenerationIdRef,
    meshGenTopologyRef,
    meshGenGenerationRef,
    pendingMeshConfigSignatureRef,
    meshConfigSignatureRef,
    setMeshEntityViewState,
    setSelectedEntityId,
    setFocusedEntityId,
    setMeshGenerating,
    setLastBuiltMeshConfigSignature,
    setSliceIndex,
    setMeshSelection,
    appendFrontendTrace,
  } = params;
  const femDiscretization = domainCapabilities
    ? isFemDiscretization(domainCapabilities)
    : isFemBackend;

  // -------------------------------------------------------------------------
  // Memos: mesh parts & filtering
  // -------------------------------------------------------------------------

  const effectiveFemMesh = useMemo(
    () => (isMeshPreview && renderPreview?.fem_mesh ? renderPreview.fem_mesh : femMesh),
    [femMesh, isMeshPreview, renderPreview?.fem_mesh],
  );
  const meshParts = useMemo<FemMeshPart[]>(
    () => effectiveFemMesh?.mesh_parts ?? [],
    [effectiveFemMesh],
  );
  const magneticParts = useMemo(
    () => meshParts.filter((part) => part.role === "magnetic_object"),
    [meshParts],
  );
  const airPart = useMemo(
    () => meshParts.find((part) => part.role === "air") ?? null,
    [meshParts],
  );
  const airRelatedParts = useMemo(
    () => meshParts.filter((part) => part.role === "air" || part.role === "outer_boundary"),
    [meshParts],
  );
  const interfaceParts = useMemo(
    () => meshParts.filter((part) => part.role === "interface"),
    [meshParts],
  );
  const visibleMeshPartIds = useMemo(
    () =>
      meshParts
        .filter(
          (part) =>
            meshEntityViewState[part.id]?.visible ?? (part.role !== "air" && part.role !== "outer_boundary"),
        )
        .map((part) => part.id),
    [meshEntityViewState, meshParts],
  );
  const visibleMagneticObjectIds = useMemo(
    () =>
      Array.from(
        new Set(
          meshParts
            .filter(
              (part) =>
                part.role === "magnetic_object" &&
                (meshEntityViewState[part.id]?.visible ?? true) &&
                typeof part.object_id === "string" &&
                part.object_id.length > 0,
            )
            .map((part) => part.object_id as string),
        ),
      ),
    [meshEntityViewState, meshParts],
  );
  const selectedMeshPart = useMemo(
    () => meshParts.find((part) => part.id === selectedEntityId) ?? null,
    [meshParts, selectedEntityId],
  );
  const focusedMeshPart = useMemo(
    () => meshParts.find((part) => part.id === focusedEntityId) ?? null,
    [focusedEntityId, meshParts],
  );
  const objectOverlays = useMemo<BuilderObjectOverlay[]>(
    () => buildObjectOverlays(scriptBuilderGeometries ?? [], effectiveFemMesh),
    [effectiveFemMesh, scriptBuilderGeometries],
  );
  const topologyBuffersRef = useRef<{
    cacheKey: string;
    nodes: ArrayLike<number>;
    boundaryFaces: ArrayLike<number>;
    elements: ArrayLike<number>;
    nNodes: number;
    nElements: number;
  } | null>(null);

  // -------------------------------------------------------------------------
  // Memos: FEM mesh data composition
  // -------------------------------------------------------------------------

  const femTopologyKey = useMemo(
    () => resolveFemTopologyCacheKey(effectiveFemMesh),
    [effectiveFemMesh],
  );
  const topologyBuffers = useMemo(() => {
    if (!effectiveFemMesh || !femTopologyKey) {
      topologyBuffersRef.current = null;
      return null;
    }
    const topologyReady =
      hasBinaryTopologyBuffers(effectiveFemMesh) || hasInlineTopologyArrays(effectiveFemMesh);
    if (!topologyReady) {
      topologyBuffersRef.current = null;
      return null;
    }
    const snapshotKey = topologySnapshotKey(effectiveFemMesh, femTopologyKey);
    if (topologyBuffersRef.current?.cacheKey === snapshotKey) {
      return topologyBuffersRef.current;
    }
    const topologyBuffers = effectiveFemMesh.topology_buffers;
    const nNodes =
      effectiveFemMesh.node_count
      ?? (topologyBuffers ? Math.floor(topologyBuffers.nodes.length / 3) : effectiveFemMesh.nodes.length);
    const nElements =
      effectiveFemMesh.element_count
      ?? (topologyBuffers ? Math.floor(topologyBuffers.elements.length / 4) : effectiveFemMesh.elements.length);
    const next = {
      cacheKey: snapshotKey,
      nodes: topologyBuffers?.nodes ?? flattenTriples(effectiveFemMesh.nodes),
      boundaryFaces:
        topologyBuffers?.boundary_faces ?? flattenTriples(effectiveFemMesh.boundary_faces),
      elements: topologyBuffers?.elements ?? flattenQuads(effectiveFemMesh.elements),
      nNodes,
      nElements,
    };
    topologyBuffersRef.current = next;
    return next;
  }, [effectiveFemMesh, femTopologyKey]);

  // Topology base: stable reference that only changes when mesh structure changes.
  // This prevents full geometry rebuild (and camera reset) on every field data update.
  const femMeshBase = useMemo<Omit<FemMeshData, "fieldData" | "activeMask" | "quantityDomain"> | null>(() => {
    if (!topologyBuffers) {
      return null;
    }
    const { nodes, elements, boundaryFaces, nNodes, nElements } = topologyBuffers;
    return { nodes, elements, boundaryFaces, nNodes, nElements };
  }, [topologyBuffers]);

  // Field data: updated on every solver tick when selectedVectors changes.
  const femFieldData = useMemo<FemMeshData["fieldData"] | undefined>(() => {
    if (!femMeshBase || !selectedVectors) return undefined;
    const nNodes = femMeshBase.nNodes;
    let buffers = femFieldBuffersRef.current;
    if (!buffers || buffers.nNodes !== nNodes) {
      buffers = {
        nNodes,
        x: new Float64Array(nNodes),
        y: new Float64Array(nNodes),
        z: new Float64Array(nNodes),
      };
      femFieldBuffersRef.current = buffers;
    }
    if (selectedFieldNComp <= 1) {
      if (selectedVectors.length < nNodes) return undefined;
      for (let i = 0; i < nNodes; i++) {
        buffers.x[i] = selectedVectors[i] ?? 0;
      }
      buffers.y.fill(0);
      buffers.z.fill(0);
      return buffers;
    }
    if (selectedVectors.length < femMeshBase.nNodes * 3) return undefined;
    for (let i = 0; i < nNodes; i++) {
      buffers.x[i] = selectedVectors[i * 3] ?? 0;
      buffers.y[i] = selectedVectors[i * 3 + 1] ?? 0;
      buffers.z[i] = selectedVectors[i * 3 + 2] ?? 0;
    }
    return buffers;
  }, [femFieldBuffersRef, femMeshBase, selectedFieldNComp, selectedVectors, fieldDataRevision]);

  // Combined: new object only when topology OR field data changes
  const femMeshData = useMemo<FemMeshData | null>(() => {
    if (!femMeshBase) return null;
    return {
      ...femMeshBase,
      fieldData: femFieldData,
      fieldNComp: selectedFieldNComp,
      activeMask:
        activeMask && activeMask.length === femMeshBase.nNodes
          ? activeMask
          : null,
      quantityDomain: selectedFieldDomain ?? spatialPreview?.quantity_domain ?? "full_domain",
      fieldRevision: fieldDataRevision,
      meshGenerationId: effectiveFemMesh?.generation_id ?? effectiveFemMesh?.mesh_id ?? null,
      // Stable topology reference: vertex-color cache keys off this object so
      // colors are not recomputed on every field update.
      topologyRef: femMeshBase,
    };
  }, [
    activeMask,
    femFieldData,
    femMeshBase,
    fieldDataRevision,
    selectedFieldDomain,
    selectedFieldNComp,
    spatialPreview?.quantity_domain,
    effectiveFemMesh?.generation_id,
    effectiveFemMesh?.mesh_id,
  ]);
  useEffect(() => {
    femMeshDataRef.current = femMeshData;
  }, [femMeshData, femMeshDataRef]);

  const femHasFieldData = Boolean(femMeshData?.fieldData);
  const femMagnetization3DActive = femDiscretization && effectiveViewMode === "3D" && activeQuantityId === "m" && femHasFieldData;
  const arrowVisibility = resolveArrowVisibility({
    isFemBackend: femDiscretization,
    effectiveViewMode,
    femHasFieldData,
    meshShowArrows,
    diagnosticForceHideArrows: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceHideArrows,
  });
  const femShouldShowArrows = arrowVisibility.visible;

  // -------------------------------------------------------------------------
  // Memos: topology key
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Effects: sync mesh entity view state
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!meshParts.length) {
      setMeshEntityViewState((prev) => (
        Object.keys(prev).length > 0 ? {} : prev
      ));
      setSelectedEntityId(null);
      setFocusedEntityId(null);
      return;
    }
    setMeshEntityViewState((prev) => {
      const prevKeys = Object.keys(prev);
      const next: MeshEntityViewStateMap = {};
      let changed = prevKeys.length !== meshParts.length;
      for (const part of meshParts) {
        const existing = prev[part.id];
        if (!existing) {
          changed = true;
        }
        next[part.id] = existing ?? defaultMeshEntityViewState(part);
      }
      return changed ? next : prev;
    });
  }, [effectiveFemMesh?.generation_id, meshParts]);

  // Effect: clear stale selections
  useEffect(() => {
    if (selectedEntityId && !meshParts.some((part) => part.id === selectedEntityId)) {
      setSelectedEntityId(null);
    }
    if (focusedEntityId && !meshParts.some((part) => part.id === focusedEntityId)) {
      setFocusedEntityId(null);
    }
  }, [focusedEntityId, meshParts, selectedEntityId]);

  // D-02 fix: Don't reduce object selection to a single part for toolbar scope.
  // selectedObjectId remains the owner of scope for composite objects.
  // selectedEntityId is set only for airbox or explicit part selection.
  // focusedEntityId must stay reserved for explicit camera focus actions,
  // not passive tree selection.
  useEffect(() => {
    if (!meshParts.length) {
      return;
    }
    let nextEntityId: string | null = null;
    let nextFocusId: string | null = null;
    if (
      selectedSidebarNodeId === "universe-airbox" ||
      selectedSidebarNodeId === "universe-airbox-mesh"
    ) {
      nextEntityId = airPart?.id ?? null;
      nextFocusId = null;
    } else if (selectedObjectId) {
      // D-02 fix: Do NOT set selectedEntityId to first part of the object.
      // The object-level scope is handled via selectedObjectId + visibleLayers.isSelected.
      // Passive selection must not set a focus anchor or move the camera.
      nextEntityId = null;
      nextFocusId = null;
    }
    if (nextEntityId !== selectedEntityId) {
      setSelectedEntityId(nextEntityId);
    }
    if (nextFocusId !== focusedEntityId) {
      setFocusedEntityId(nextFocusId);
    }
  }, [
    airPart?.id,
    focusedEntityId,
    meshParts,
    selectedEntityId,
    selectedObjectId,
    selectedSidebarNodeId,
  ]);

  // D-04 fix: Sync air visibility to per-part state ONLY as a command (not continuous sync).
  // Use a ref to track the previous airMeshVisible value so we only patch on intentional changes.
  const forcedAirboxDefaultAppliedRef = useRef(false);
  const prevAirVisibleRef = useRef(airMeshVisible);
  const prevAirOpacityRef = useRef(airMeshOpacity);

  useEffect(() => {
    if (
      forcedAirboxDefaultAppliedRef.current ||
      !FRONTEND_DIAGNOSTIC_FLAGS.femViewport.airboxDisabledByDefault ||
      airRelatedParts.length === 0
    ) {
      return;
    }
    forcedAirboxDefaultAppliedRef.current = true;
    prevAirVisibleRef.current = false;
    setMeshEntityViewState((prev) => {
      let changed = false;
      const next: MeshEntityViewStateMap = { ...prev };
      for (const part of airRelatedParts) {
        const current = next[part.id] ?? defaultMeshEntityViewState(part);
        if (current.visible === false) {
          if (!next[part.id]) {
            next[part.id] = current;
            changed = true;
          }
          continue;
        }
        next[part.id] = {
          ...current,
          visible: false,
        };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [airRelatedParts, setMeshEntityViewState]);

  useEffect(() => {
    if (airRelatedParts.length === 0) {
      return;
    }
    // Only trigger when airMeshVisible or airMeshOpacity actually changed from the UI
    const visChanged = prevAirVisibleRef.current !== airMeshVisible;
    const opChanged = prevAirOpacityRef.current !== airMeshOpacity;
    prevAirVisibleRef.current = airMeshVisible;
    prevAirOpacityRef.current = airMeshOpacity;
    if (!visChanged && !opChanged) {
      return;
    }
    setMeshEntityViewState((prev) => {
      let changed = false;
      const next: MeshEntityViewStateMap = { ...prev };
      for (const part of airRelatedParts) {
        const current = next[part.id] ?? defaultMeshEntityViewState(part);
        const nextVisible = airMeshVisible;
        const nextOpacity = part.role === "air" ? airMeshOpacity : current.opacity;
        if (current.visible === nextVisible && current.opacity === nextOpacity) {
          if (!next[part.id]) {
            next[part.id] = current;
            changed = true;
          }
          continue;
        }
        next[part.id] = {
          ...current,
          visible: nextVisible,
          opacity: nextOpacity,
        };
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [airMeshOpacity, airMeshVisible, airRelatedParts]);

  // Keep refs in sync so remesh actions can snapshot current topology/generation safely.
  useEffect(() => {
    femTopologyKeyRef.current = femTopologyKey;
    femGenerationIdRef.current =
      effectiveFemMesh?.generation_id ?? meshSummary?.generation_id ?? null;
  }, [
    effectiveFemMesh?.generation_id,
    femGenerationIdRef,
    femTopologyKey,
    femTopologyKeyRef,
    meshSummary?.generation_id,
  ]);

  // Effect: clear meshGenerating on topology change
  useEffect(() => {
    if (!meshGenerating) return;
    const meshBuildRuntime = deriveMeshBuildRuntimeState({
      meshWorkspace,
      commandStatus,
      meshGenerating,
      scriptSyncBusy: false,
    });
    if (meshBuildRuntime.status === "failure") {
      meshGenTopologyRef.current = null;
      meshGenGenerationRef.current = null;
      pendingMeshConfigSignatureRef.current = null;
      setMeshGenerating(false);
      return;
    }
    if (meshBuildRuntime.hasStructuredSuccess) {
      const nodeCount =
        meshSummary?.node_count
        ?? (effectiveFemMesh ? effectiveFemMesh.nodes.length : 0);
      const elementCount =
        meshSummary?.element_count
        ?? (effectiveFemMesh ? effectiveFemMesh.elements.length : 0);
      appendFrontendTrace(
        "success",
        `RX: REMESH confirmed by backend — ${nodeCount.toLocaleString()} nodes · ${elementCount.toLocaleString()} tetrahedra`,
      );
      setLastBuiltMeshConfigSignature(
        pendingMeshConfigSignatureRef.current ?? meshConfigSignatureRef.current,
      );
      meshGenTopologyRef.current = null;
      meshGenGenerationRef.current = null;
      pendingMeshConfigSignatureRef.current = null;
      setMeshGenerating(false);
      return;
    }
    const currentGenerationId =
      effectiveFemMesh?.generation_id ?? meshSummary?.generation_id ?? null;
    const generationChanged =
      currentGenerationId != null &&
      meshGenGenerationRef.current != null &&
      currentGenerationId !== meshGenGenerationRef.current;
    const topologyChanged =
      meshGenTopologyRef.current !== null &&
      femTopologyKey !== null &&
      femTopologyKey !== meshGenTopologyRef.current;
    if (generationChanged || topologyChanged) {
      const nodeCount =
        meshSummary?.node_count
        ?? (effectiveFemMesh ? effectiveFemMesh.nodes.length : 0);
      const elementCount =
        meshSummary?.element_count
        ?? (effectiveFemMesh ? effectiveFemMesh.elements.length : 0);
      appendFrontendTrace(
        "success",
        `RX: REMESH mesh ready — ${nodeCount.toLocaleString()} nodes · ${elementCount.toLocaleString()} tetrahedra`,
      );
      setLastBuiltMeshConfigSignature(
        pendingMeshConfigSignatureRef.current ?? meshConfigSignatureRef.current,
      );
      meshGenTopologyRef.current = null;
      meshGenGenerationRef.current = null;
      pendingMeshConfigSignatureRef.current = null;
      setMeshGenerating(false);
    }
  }, [appendFrontendTrace, commandStatus, effectiveFemMesh, femTopologyKey, meshGenerating, meshSummary, meshWorkspace]);

  // -------------------------------------------------------------------------
  // Memos: color field, workspace, config
  // -------------------------------------------------------------------------

  const femColorField = useMemo<FemColorField>(() => {
    const qId = activeQuantityId;
    if (effectiveVectorComponent === "x") return "x";
    if (effectiveVectorComponent === "y") return "y";
    if (effectiveVectorComponent === "z") return "z";
    if (qId === "m" && effectiveViewMode === "3D" && femHasFieldData) return "orientation";
    return "magnitude";
  }, [activeQuantityId, effectiveVectorComponent, effectiveViewMode, femHasFieldData]);

  // Effect: reset meshSelection on topology change
  useEffect(() => {
    setMeshSelection({ selectedFaceIndices: [], primaryFaceIndex: null });
  }, [femTopologyKey]);

  const isMeshWorkspaceView = effectiveViewMode === "Mesh";
  const meshWorkspacePreset = useMemo(
    () => deriveMeshWorkspacePreset({ viewMode: effectiveViewMode, femDockTab, meshRenderMode }),
    [effectiveViewMode, femDockTab, meshRenderMode],
  );
  const meshConfigDirty = useMemo(
    () =>
      meshConfigSignature != null &&
      lastBuiltMeshConfigSignature != null &&
      meshConfigSignature !== lastBuiltMeshConfigSignature,
    [lastBuiltMeshConfigSignature, meshConfigSignature],
  );
  const meshFaceDetail = useMemo(
    () => computeMeshFaceDetail(effectiveFemMesh, meshSelection.primaryFaceIndex),
    [effectiveFemMesh, meshSelection.primaryFaceIndex],
  );

  const meshQualitySummary = useMemo<MeshQualitySummary | null>(() => {
    if (!effectiveFemMesh) return null;
    const nodes = effectiveFemMesh.nodes;
    const faces = effectiveFemMesh.boundary_faces;
    if (!nodes.length || !faces.length) return null;
    let min = Infinity, max = -Infinity, sum = 0, good = 0, fair = 0, poor = 0;
    for (const [ia, ib, ic] of faces) {
      const a = nodes[ia], b = nodes[ib], c = nodes[ic];
      if (!a || !b || !c) continue;
      const ab = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
      const bc = Math.hypot(c[0]-b[0], c[1]-b[1], c[2]-b[2]);
      const ca = Math.hypot(a[0]-c[0], a[1]-c[1], a[2]-c[2]);
      const maxE = Math.max(ab, bc, ca);
      const s2 = (ab+bc+ca)/2;
      const area = Math.sqrt(Math.max(0, s2*(s2-ab)*(s2-bc)*(s2-ca)));
      const inr = s2 > 0 ? area/s2 : 0;
      const ar = inr > 1e-18 ? maxE/(2*inr) : 1;
      min = Math.min(min, ar); max = Math.max(max, ar); sum += ar;
      if (ar < 3) good++; else if (ar < 6) fair++; else poor++;
    }
    return { min, max, mean: faces.length > 0 ? sum/faces.length : 0, good, fair, poor, count: faces.length };
  }, [effectiveFemMesh]);

  // -------------------------------------------------------------------------
  // Memos: slice, field stats, material, empty state, footer, error, log
  // -------------------------------------------------------------------------

  /* Slice count */
  const maxSliceCount = useMemo(() => {
    if (spatialPreview?.spatial_kind === "grid") return 1;
    if (femDiscretization && femMeshData) return FEM_SLICE_COUNT;
    if (plane === "xy") return Math.max(1, previewGrid[2]);
    if (plane === "xz") return Math.max(1, previewGrid[1]);
    return Math.max(1, previewGrid[0]);
  }, [femDiscretization, femMeshData, plane, spatialPreview?.spatial_kind, previewGrid]);

  // Effect: clamp sliceIndex
  useEffect(() => {
    if (sliceIndex >= maxSliceCount) setSliceIndex(Math.max(0, maxSliceCount - 1));
  }, [maxSliceCount, sliceIndex]);

  /* Field stats */
  const fieldStats = useMemo<FieldStats | null>(() => {
    if (!selectedVectors) return null;
    const n = femDiscretization ? (effectiveFemMesh?.nodes.length ?? 0) : Math.floor(selectedVectors.length / 3);
    if (n <= 0 || selectedVectors.length < n * 3) return null;
    let sumX = 0, sumY = 0, sumZ = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const vx = selectedVectors[i*3], vy = selectedVectors[i*3+1], vz = selectedVectors[i*3+2];
      sumX += vx; sumY += vy; sumZ += vz;
      if (vx < minX) minX = vx; if (vx > maxX) maxX = vx;
      if (vy < minY) minY = vy; if (vy > maxY) maxY = vy;
      if (vz < minZ) minZ = vz; if (vz > maxZ) maxZ = vz;
    }
    const inv = 1/n;
    return { meanX: sumX*inv, meanY: sumY*inv, meanZ: sumZ*inv, minX, minY, minZ, maxX, maxY, maxZ };
  }, [selectedVectors, femDiscretization, effectiveFemMesh]);

  /* Material */
  const material = useMemo<MaterialSummary | null>(() => {
    if (!solverPlan) return null;
    return {
      msat: solverPlan.materialMsat,
      aex: solverPlan.materialAex,
      alpha: solverPlan.materialAlpha,
      exchangeEnabled: solverPlan.exchangeEnabled,
      demagEnabled: solverPlan.demagEnabled,
      zeemanField: solverPlan.externalField ? [...solverPlan.externalField] : null,
      name: solverPlan.materialName,
    };
  }, [solverPlan]);

  /* Empty state */
  const emptyStateMessage = useMemo(() => {
    if (femDiscretization && !femMeshData) {
      if (workspaceStatus === "materializing_script")
        return { title: "Materializing FEM mesh", description: latestEngineMessage ?? "Importing geometry and preparing the FEM mesh." };
      if (workspaceStatus === "bootstrapping")
        return { title: "Bootstrapping live workspace", description: latestEngineMessage ?? "Starting the local workspace." };
      return { title: "Waiting for FEM preview data", description: latestEngineMessage ?? "The mesh topology is not available yet." };
    }
    // Mesh topology exists but no field data for the selected quantity
    if (femDiscretization && femMeshData && !femMeshData.fieldData && activeQuantityId) {
      return {
        title: `No live frame for "${activeQuantityId}"`,
        description: "Mesh topology is ready but the solver has not yet sent vector data for this quantity. Waiting for the next step update.",
      };
    }
    if (workspaceStatus === "materializing_script")
      return { title: "Materializing workspace", description: latestEngineMessage ?? "Preparing problem description and first preview." };
    return { title: "No preview data yet", description: latestEngineMessage ?? "Waiting for the first live field snapshot." };
  }, [activeQuantityId, femDiscretization, femMeshData, latestEngineMessage, workspaceStatus]);

  const sessionFooter = useMemo<SessionFooterData>(() => ({
    requestedBackend: session?.requested_backend ?? null,
    scriptPath: session?.script_path ?? null,
    artifactDir: session?.artifact_dir ?? null,
  }), [session?.requested_backend, session?.script_path, session?.artifact_dir]);
  const latestBackendError = useMemo<BackendErrorInfo | null>(
    () => latestBackendErrorFromLog(engineLog ?? []),
    [engineLog],
  );
  const mergedEngineLog = useMemo<EngineLogEntry[]>(
    () => [...(engineLog ?? []), ...frontendTraceLog],
    [engineLog, frontendTraceLog],
  );

  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------

  return {
    effectiveFemMesh,
    meshParts,
    magneticParts,
    airPart,
    airRelatedParts,
    interfaceParts,
    visibleMeshPartIds,
    visibleMagneticObjectIds,
    selectedMeshPart,
    focusedMeshPart,
    objectOverlays,
    femMeshData,
    femHasFieldData,
    femMagnetization3DActive,
    femShouldShowArrows,
    arrowVisibility,
    femTopologyKey,
    femColorField,
    isMeshWorkspaceView,
    meshWorkspacePreset,
    meshConfigDirty,
    meshFaceDetail,
    meshQualitySummary,
    maxSliceCount,
    fieldStats,
    material,
    emptyStateMessage,
    sessionFooter,
    latestBackendError,
    mergedEngineLog,
  };
}
