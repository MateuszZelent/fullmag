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
} from "../../../preview/FemMeshView3D";
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
import type { EngineLogEntry } from "../../../../lib/useSessionStream";
import {
  resolveArrowVisibility,
  type ArrowVisibilityStatus,
} from "../../../../features/viewport-fem/model/femArrowVisibility";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "../../../../lib/debug/frontendDiagnosticFlags";

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
  activeMask: boolean[] | null;
  spatialPreview: any;
  meshShowArrows: boolean;
  effectiveViewMode: ViewportMode;
  activeQuantityId: string;
  isFemBackend: boolean;
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
    activeMask,
    spatialPreview,
    meshShowArrows,
    effectiveViewMode,
    activeQuantityId,
    isFemBackend,
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

  // -------------------------------------------------------------------------
  // Memos: FEM mesh data composition
  // -------------------------------------------------------------------------

  const [flatNodes, flatFaces, flatElements] = useMemo(() => {
    if (!effectiveFemMesh) return [null, null, null];
    return [
      effectiveFemMesh.nodes.flatMap((n: number[]) => n),
      effectiveFemMesh.boundary_faces.flatMap((f: number[]) => f),
      effectiveFemMesh.elements.flatMap((element: number[]) => element),
    ];
  }, [effectiveFemMesh]);

  // Topology base: stable reference that only changes when mesh structure changes.
  // This prevents full geometry rebuild (and camera reset) on every field data update.
  const femMeshBase = useMemo<Omit<FemMeshData, "fieldData" | "activeMask" | "quantityDomain"> | null>(() => {
    if (!effectiveFemMesh || !flatNodes || !flatFaces || !flatElements) return null;
    const nNodes = effectiveFemMesh.nodes.length;
    const nElements = effectiveFemMesh.elements.length;
    return { nodes: flatNodes, elements: flatElements, boundaryFaces: flatFaces, nNodes, nElements };
  }, [effectiveFemMesh, flatNodes, flatFaces, flatElements]);

  // Field data: updated on every solver tick when selectedVectors changes.
  const femFieldData = useMemo<FemMeshData["fieldData"] | undefined>(() => {
    if (!femMeshBase || !selectedVectors || selectedVectors.length < femMeshBase.nNodes * 3) return undefined;
    const nNodes = femMeshBase.nNodes;
    const x = new Float64Array(nNodes);
    const y = new Float64Array(nNodes);
    const z = new Float64Array(nNodes);
    for (let i = 0; i < nNodes; i++) {
      x[i] = selectedVectors[i * 3] ?? 0;
      y[i] = selectedVectors[i * 3 + 1] ?? 0;
      z[i] = selectedVectors[i * 3 + 2] ?? 0;
    }
    return { x, y, z };
  }, [femMeshBase, selectedVectors]);

  // Combined: new object only when topology OR field data changes
  const femMeshData = useMemo<FemMeshData | null>(() => {
    if (!femMeshBase) return null;
    return {
      ...femMeshBase,
      fieldData: femFieldData,
      activeMask:
        activeMask && activeMask.length === femMeshBase.nNodes
          ? activeMask
          : null,
      quantityDomain: spatialPreview?.quantity_domain ?? "full_domain",
    };
  }, [activeMask, femFieldData, femMeshBase, spatialPreview?.quantity_domain]);
  useEffect(() => {
    femMeshDataRef.current = femMeshData;
  }, [femMeshData, femMeshDataRef]);

  const femHasFieldData = Boolean(femMeshData?.fieldData);
  const femMagnetization3DActive = isFemBackend && effectiveViewMode === "3D" && activeQuantityId === "m" && femHasFieldData;
  const arrowVisibility = resolveArrowVisibility({
    isFemBackend,
    effectiveViewMode,
    femHasFieldData,
    meshShowArrows,
    diagnosticForceHideArrows: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceHideArrows,
  });
  const femShouldShowArrows = arrowVisibility.visible;

  // -------------------------------------------------------------------------
  // Memos: topology key
  // -------------------------------------------------------------------------

  const femTopologyKey = useMemo(() => {
    if (!effectiveFemMesh) return null;
    const firstNode = effectiveFemMesh.nodes[0]?.join(",") ?? "";
    const middleNode = effectiveFemMesh.nodes[Math.floor(effectiveFemMesh.nodes.length / 2)]?.join(",") ?? "";
    const lastNode = effectiveFemMesh.nodes[effectiveFemMesh.nodes.length - 1]?.join(",") ?? "";
    const firstElement = effectiveFemMesh.elements[0]?.join(",") ?? "";
    return [
      effectiveFemMesh.nodes.length,
      femMesh?.elements.length ?? effectiveFemMesh.elements.length,
      effectiveFemMesh.boundary_faces.length,
      firstNode,
      middleNode,
      lastNode,
      firstElement,
    ].join(":");
  }, [effectiveFemMesh, femMesh?.elements.length]);

  // -------------------------------------------------------------------------
  // Effects: sync mesh entity view state
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!meshParts.length) {
      setMeshEntityViewState({});
      setSelectedEntityId(null);
      setFocusedEntityId(null);
      return;
    }
    setMeshEntityViewState((prev) => {
      const next: MeshEntityViewStateMap = {};
      for (const part of meshParts) {
        next[part.id] = prev[part.id] ?? defaultMeshEntityViewState(part);
      }
      return next;
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
  // focusedEntityId is set for camera anchor purposes only.
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
      nextFocusId = nextEntityId;
    } else if (selectedObjectId) {
      // D-02 fix: Do NOT set selectedEntityId to first part of the object.
      // The object-level scope is handled via selectedObjectId + visibleLayers.isSelected.
      // Only set focusedEntityId for camera anchor.
      nextEntityId = null;
      nextFocusId = meshParts.find(
        (part) =>
          part.role === "magnetic_object" && part.object_id === selectedObjectId,
      )?.id ?? null;
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
    if (qId === "m" && effectiveViewMode === "3D" && femHasFieldData) return "orientation";
    if (effectiveVectorComponent === "x") return "x";
    if (effectiveVectorComponent === "y") return "y";
    if (effectiveVectorComponent === "z") return "z";
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
    if (isFemBackend && femMeshData) return FEM_SLICE_COUNT;
    if (plane === "xy") return Math.max(1, previewGrid[2]);
    if (plane === "xz") return Math.max(1, previewGrid[1]);
    return Math.max(1, previewGrid[0]);
  }, [femMeshData, isFemBackend, plane, spatialPreview?.spatial_kind, previewGrid]);

  // Effect: clamp sliceIndex
  useEffect(() => {
    if (sliceIndex >= maxSliceCount) setSliceIndex(Math.max(0, maxSliceCount - 1));
  }, [maxSliceCount, sliceIndex]);

  /* Field stats */
  const fieldStats = useMemo<FieldStats | null>(() => {
    if (!selectedVectors) return null;
    const n = isFemBackend ? (effectiveFemMesh?.nodes.length ?? 0) : Math.floor(selectedVectors.length / 3);
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
  }, [selectedVectors, isFemBackend, effectiveFemMesh]);

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
    if (isFemBackend && !femMeshData) {
      if (workspaceStatus === "materializing_script")
        return { title: "Materializing FEM mesh", description: latestEngineMessage ?? "Importing geometry and preparing the FEM mesh." };
      if (workspaceStatus === "bootstrapping")
        return { title: "Bootstrapping live workspace", description: latestEngineMessage ?? "Starting the local workspace." };
      return { title: "Waiting for FEM preview data", description: latestEngineMessage ?? "The mesh topology is not available yet." };
    }
    // Mesh topology exists but no field data for the selected quantity
    if (isFemBackend && femMeshData && !femMeshData.fieldData && activeQuantityId) {
      return {
        title: `No live frame for "${activeQuantityId}"`,
        description: "Mesh topology is ready but the solver has not yet sent vector data for this quantity. Waiting for the next step update.",
      };
    }
    if (workspaceStatus === "materializing_script")
      return { title: "Materializing workspace", description: latestEngineMessage ?? "Preparing problem description and first preview." };
    return { title: "No preview data yet", description: latestEngineMessage ?? "Waiting for the first live field snapshot." };
  }, [activeQuantityId, femMeshData, isFemBackend, latestEngineMessage, workspaceStatus]);

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
