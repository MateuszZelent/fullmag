import { useEffect, useMemo, useRef, useState } from "react";
import { decodeFieldVector } from "@/src/api/codecs/fieldVectorCodec";
import type {
  FemLiveMesh,
  LatestFieldFrame,
  QuantityDescriptor,
  SceneDocument,
  SpatialPreviewState,
} from "@/lib/session/types";
import { getFrontendPerfSamples, recordFrontendPerfSample } from "@/lib/debug/frontendPerfDebug";
import { updateFrontendResourceBucket } from "@/lib/debug/frontendResourceManager";
import { buildAuthoredMagnetizationPreview } from "../authoredMagnetizationPreview";
import {
  buildDenseFemVectorField,
  deriveFemVectorScopes,
  type ScopedFemVectorFrame,
} from "../femVectorScopes";
import {
  BINARY_FIELD_CACHE_MAX_BYTES,
  SCOPED_BINARY_FIELD_CACHE_MAX_BYTES,
  estimateBinaryFieldCacheBytes,
  estimateBinaryFieldFrameBytes,
  estimateScopedBinaryFieldFrameBytes,
  femVectorScopeKey,
  pruneBinaryFieldCache,
  type BinaryFieldFrame,
  type ScopedBinaryFieldFrame,
} from "../binaryFieldCache";
import type { ViewportMode } from "../shared";
import {
  fieldFrameIdentity,
  vectorHead,
} from "../controlRoomContextHelpers";
import { selectViewportVectorField } from "../viewportSelection";
import type { ViewportVisualizationState } from "../visualizationStateSync";

type LiveFieldApi = {
  getFieldVectorBinary: (
    quantityId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<ArrayBuffer>;
  getScopedFieldVectorBinary: (
    quantityId: string,
    scope: Parameters<typeof femVectorScopeKey>[0][number],
    options?: { signal?: AbortSignal },
  ) => Promise<ArrayBuffer>;
};

export function resolveSelectedLiveField(args: {
  activeQuantityId: string | null;
  fieldMap: Record<string, Float64Array | null>;
  selectedScopedBinaryFieldFrame: ScopedBinaryFieldFrame | null;
  scopedFieldTransportKey: string | null;
  selectedFieldTopologyMismatch: boolean;
  selectedBinaryFieldFrame: BinaryFieldFrame | null;
  selectedFieldTransportKey: string | null;
}): Float64Array | null {
  const {
    activeQuantityId,
    fieldMap,
    selectedScopedBinaryFieldFrame,
    scopedFieldTransportKey,
    selectedFieldTopologyMismatch,
    selectedBinaryFieldFrame,
    selectedFieldTransportKey,
  } = args;
  if (selectedScopedBinaryFieldFrame?.key === scopedFieldTransportKey) {
    return selectedScopedBinaryFieldFrame.values;
  }
  if (selectedFieldTopologyMismatch) {
    return null;
  }
  if (selectedBinaryFieldFrame?.key === selectedFieldTransportKey) {
    return selectedBinaryFieldFrame.values;
  }
  if (!activeQuantityId) {
    return null;
  }
  if ((fieldMap[activeQuantityId]?.length ?? 0) > 0) {
    return fieldMap[activeQuantityId]!;
  }
  return selectedBinaryFieldFrame?.key === selectedFieldTransportKey
    ? selectedBinaryFieldFrame.values
    : null;
}

export function useViewportFieldData({
  activeFemGenerationSignature,
  activeQuantityId,
  activeTransformScope,
  binaryFieldTransportEnabled,
  debugLogsEnabled,
  effectiveIsFemBackend,
  effectiveStep,
  effectiveViewMode,
  effectiveViewportVisualizationState,
  femMesh,
  isFemBackend,
  isGlobalScalarQuantity,
  isWaitingForCompute,
  latestFieldFrames,
  liveApi,
  meshEntityViewState,
  quantityDescriptorById,
  remoteSceneDocument,
  renderPreview,
  requestedPreviewQuantity,
  previewControlsActive,
  sceneDocumentDraft,
  selectedObjectId,
  selectedSidebarNodeId,
  workspaceStatus,
}: {
  activeFemGenerationSignature: string | null;
  activeQuantityId: string | null;
  activeTransformScope: "object" | "texture" | null;
  binaryFieldTransportEnabled: boolean;
  debugLogsEnabled: boolean;
  effectiveIsFemBackend: boolean;
  effectiveStep: number;
  effectiveViewMode: ViewportMode;
  effectiveViewportVisualizationState: ViewportVisualizationState;
  femMesh: FemLiveMesh | null;
  isFemBackend: boolean;
  isGlobalScalarQuantity: (quantity: string | null | undefined) => boolean;
  isWaitingForCompute: boolean;
  latestFieldFrames: Record<string, LatestFieldFrame>;
  liveApi: LiveFieldApi;
  meshEntityViewState: Parameters<typeof deriveFemVectorScopes>[0]["meshEntityViewState"];
  quantityDescriptorById: Map<string, QuantityDescriptor>;
  remoteSceneDocument: SceneDocument | null;
  renderPreview: SpatialPreviewState | null;
  requestedPreviewQuantity: string;
  previewControlsActive: boolean;
  sceneDocumentDraft: SceneDocument | null;
  selectedObjectId: string | null;
  selectedSidebarNodeId: string | null;
  workspaceStatus: string | null;
}) {
  const binaryFieldCacheRef = useRef<Map<string, BinaryFieldFrame>>(new Map());
  const scopedBinaryFieldCacheRef = useRef<Map<string, ScopedBinaryFieldFrame>>(new Map());
  const lastFieldDataRevisionRef = useRef<string | null>(null);
  const fieldDataTimestampRef = useRef<number | null>(null);
  const lastQuantitySwitchTraceKeyRef = useRef<string | null>(null);
  const [selectedBinaryFieldFrame, setSelectedBinaryFieldFrame] =
    useState<BinaryFieldFrame | null>(null);
  const [selectedScopedBinaryFieldFrame, setSelectedScopedBinaryFieldFrame] =
    useState<ScopedBinaryFieldFrame | null>(null);

  const fieldMap = useMemo<Record<string, Float64Array | null>>(
    () =>
      Object.fromEntries(
        Object.entries(latestFieldFrames).map(([quantityId, frame]) => [
          quantityId,
          frame.values,
        ]),
      ) as Record<string, Float64Array | null>,
    [latestFieldFrames],
  );
  const selectedFieldFrame = activeQuantityId ? latestFieldFrames[activeQuantityId] ?? null : null;
  const selectedFieldNComp =
    selectedFieldFrame?.n_comp
    ?? (activeQuantityId ? quantityDescriptorById.get(activeQuantityId)?.n_comp ?? 3 : 3);
  const selectedFieldCatalogDomain =
    activeQuantityId
      ? (quantityDescriptorById.get(activeQuantityId)?.domain ?? null)
      : null;
  const liveFieldSourceStep =
    selectedFieldFrame?.source_step
    ?? selectedFieldFrame?.field_revision
    ?? null;
  const previewSourceStep = renderPreview?.source_step ?? null;
  const selectedFieldDomain =
    (selectedFieldFrame?.domain as "magnetic_only" | "full_domain" | "surface_only" | null | undefined)
    ?? selectedFieldCatalogDomain
    ?? null;

  const authoredMagnetizationPreview = useMemo(
    () => activeQuantityId === "m" && workspaceStatus !== "running"
      ? buildAuthoredMagnetizationPreview({
          scene: sceneDocumentDraft ?? remoteSceneDocument,
          mesh: femMesh,
          selectedSidebarNodeId,
          selectedObjectId,
          activeTransformScope,
          includeAllObjects: isFemBackend && isWaitingForCompute,
        })
      : null,
    [
      activeQuantityId,
      activeTransformScope,
      femMesh,
      isFemBackend,
      isWaitingForCompute,
      remoteSceneDocument,
      sceneDocumentDraft,
      selectedObjectId,
      selectedSidebarNodeId,
      workspaceStatus,
    ],
  );

  const selectedFieldTransportKey = useMemo(() => {
    if (!binaryFieldTransportEnabled || !activeQuantityId || !selectedFieldFrame) {
      return null;
    }
    const revision =
      selectedFieldFrame.field_revision
      ?? selectedFieldFrame.source_step
      ?? selectedFieldFrame.source_time
      ?? "none";
    return [
      activeQuantityId,
      revision,
      selectedFieldFrame.n_comp,
      selectedFieldFrame.grid.join("x"),
    ].join(":");
  }, [activeQuantityId, binaryFieldTransportEnabled, selectedFieldFrame]);

  const scopedFemVectorScopes = useMemo(
    () =>
      deriveFemVectorScopes({
        meshParts: femMesh?.mesh_parts ?? [],
        meshEntityViewState,
        airMeshVisible: effectiveViewportVisualizationState.airMeshVisible,
        vectorDomainFilter: effectiveViewportVisualizationState.femVectorDomainFilter,
        selectedFieldDomain,
      }),
    [
      effectiveViewportVisualizationState.airMeshVisible,
      effectiveViewportVisualizationState.femVectorDomainFilter,
      femMesh?.mesh_parts,
      meshEntityViewState,
      selectedFieldDomain,
    ],
  );

  const scopedFieldTransportKey = useMemo(() => {
    if (
      !binaryFieldTransportEnabled ||
      !isFemBackend ||
      effectiveViewMode !== "3D" ||
      (
        !effectiveViewportVisualizationState.meshShowArrows &&
        !effectiveViewportVisualizationState.femViewportLayers.showQuantity &&
        !(effectiveViewportVisualizationState.femViewportLayers.showMagneticTexture && activeQuantityId === "m")
      ) ||
      !activeQuantityId ||
      !selectedFieldFrame ||
      scopedFemVectorScopes.length === 0 ||
      scopedFemVectorScopes.some((scope) => scope.kind === "full")
    ) {
      return null;
    }
    const revision =
      selectedFieldFrame.field_revision ??
      selectedFieldFrame.source_step ??
      selectedFieldFrame.source_time ??
      "none";
    return [
      activeQuantityId,
      revision,
      selectedFieldFrame.n_comp,
      femMesh?.generation_id ?? femMesh?.mesh_id ?? "no-mesh",
      femMesh?.node_count ?? 0,
      femVectorScopeKey(scopedFemVectorScopes),
    ].join(":");
  }, [
    activeQuantityId,
    binaryFieldTransportEnabled,
    effectiveViewMode,
    effectiveViewportVisualizationState.femViewportLayers.showMagneticTexture,
    effectiveViewportVisualizationState.femViewportLayers.showQuantity,
    effectiveViewportVisualizationState.meshShowArrows,
    femMesh?.generation_id,
    femMesh?.mesh_id,
    femMesh?.node_count,
    isFemBackend,
    scopedFemVectorScopes,
    selectedFieldFrame,
  ]);

  const selectedFieldTopologyMismatch = useMemo(() => {
    if (!isFemBackend) {
      return false;
    }
    if (!activeFemGenerationSignature || !selectedFieldFrame?.topology_signature) {
      return false;
    }
    if (!selectedFieldFrame.topology_signature.startsWith("gen:")) {
      return false;
    }
    return selectedFieldFrame.topology_signature !== activeFemGenerationSignature;
  }, [activeFemGenerationSignature, isFemBackend, selectedFieldFrame?.topology_signature]);

  useEffect(() => {
    if (
      !binaryFieldTransportEnabled ||
      !activeQuantityId ||
      !selectedFieldFrame ||
      scopedFieldTransportKey != null ||
      selectedFieldFrame.values.length > 0
    ) {
      setSelectedBinaryFieldFrame(null);
      updateFrontendResourceBucket({
        id: "binary-field-cache",
        label: "Binary field cache",
        entries: binaryFieldCacheRef.current.size,
        estimatedBytes: estimateBinaryFieldCacheBytes(binaryFieldCacheRef.current),
        capacity: BINARY_FIELD_CACHE_MAX_BYTES,
      });
      return;
    }
    if (!selectedFieldTransportKey) {
      setSelectedBinaryFieldFrame(null);
      updateFrontendResourceBucket({
        id: "binary-field-cache",
        label: "Binary field cache",
        entries: binaryFieldCacheRef.current.size,
        estimatedBytes: estimateBinaryFieldCacheBytes(binaryFieldCacheRef.current),
        capacity: BINARY_FIELD_CACHE_MAX_BYTES,
      });
      return;
    }
    const cached = binaryFieldCacheRef.current.get(selectedFieldTransportKey) ?? null;
    if (cached) {
      setSelectedBinaryFieldFrame(cached);
      updateFrontendResourceBucket({
        id: "binary-field-cache",
        label: "Binary field cache",
        entries: binaryFieldCacheRef.current.size,
        estimatedBytes: estimateBinaryFieldCacheBytes(binaryFieldCacheRef.current),
        capacity: BINARY_FIELD_CACHE_MAX_BYTES,
      });
      return;
    }
    const controller = new AbortController();
    void liveApi
      .getFieldVectorBinary(activeQuantityId, { signal: controller.signal })
      .then((buffer) => {
        const decoded = decodeFieldVector(buffer);
        const resolvedQuantityId =
          decoded.quantityId.trim().length > 0 ? decoded.quantityId : activeQuantityId;
        const nextFrame: BinaryFieldFrame = {
          key: selectedFieldTransportKey,
          quantityId: resolvedQuantityId,
          values: decoded.values,
          nComp: decoded.nComp,
          grid: decoded.grid,
        };
        const cache = binaryFieldCacheRef.current;
        cache.set(selectedFieldTransportKey, nextFrame);
        const estimatedBytes = pruneBinaryFieldCache(
          cache,
          estimateBinaryFieldFrameBytes,
          BINARY_FIELD_CACHE_MAX_BYTES,
        );
        updateFrontendResourceBucket({
          id: "binary-field-cache",
          label: "Binary field cache",
          entries: cache.size,
          estimatedBytes,
          capacity: BINARY_FIELD_CACHE_MAX_BYTES,
        });
        if (!controller.signal.aborted) {
          setSelectedBinaryFieldFrame(nextFrame);
        }
      })
      .catch(() => {
        // Keep the last valid frame visible while a replacement binary frame is unavailable.
      });
    return () => controller.abort();
  }, [
    activeQuantityId,
    binaryFieldTransportEnabled,
    liveApi,
    scopedFieldTransportKey,
    selectedFieldFrame,
    selectedFieldTransportKey,
  ]);

  useEffect(() => {
    if (
      !scopedFieldTransportKey ||
      !activeQuantityId ||
      !femMesh ||
      !selectedFieldFrame
    ) {
      setSelectedScopedBinaryFieldFrame(null);
      return;
    }
    const meshParts = femMesh.mesh_parts ?? [];
    const nNodes = femMesh.node_count ?? 0;
    if (meshParts.length === 0 || nNodes <= 0) {
      setSelectedScopedBinaryFieldFrame(null);
      return;
    }
    const cached = scopedBinaryFieldCacheRef.current.get(scopedFieldTransportKey) ?? null;
    if (cached) {
      setSelectedScopedBinaryFieldFrame(cached);
      return;
    }
    const controller = new AbortController();
    void Promise.all(
      scopedFemVectorScopes.map(async (scope): Promise<ScopedFemVectorFrame> => {
        const buffer = await liveApi.getScopedFieldVectorBinary(activeQuantityId, scope, {
          signal: controller.signal,
        });
        return {
          scope,
          field: decodeFieldVector(buffer),
        };
      }),
    )
      .then((frames) => {
        const dense = buildDenseFemVectorField({
          nNodes,
          meshParts,
          frames,
        });
        if (!dense) {
          return null;
        }
        const nextFrame: ScopedBinaryFieldFrame = {
          key: scopedFieldTransportKey,
          quantityId: activeQuantityId,
          values: dense.values,
          nComp: dense.nComp,
          grid: dense.grid,
          activeMask: dense.activeMask,
          scopes: scopedFemVectorScopes,
        };
        const cache = scopedBinaryFieldCacheRef.current;
        cache.set(scopedFieldTransportKey, nextFrame);
        const estimatedBytes = pruneBinaryFieldCache(
          cache,
          estimateScopedBinaryFieldFrameBytes,
          SCOPED_BINARY_FIELD_CACHE_MAX_BYTES,
        );
        updateFrontendResourceBucket({
          id: "scoped-binary-field-cache",
          label: "Scoped binary field cache",
          entries: cache.size,
          estimatedBytes,
          capacity: SCOPED_BINARY_FIELD_CACHE_MAX_BYTES,
        });
        return nextFrame;
      })
      .then((nextFrame) => {
        if (!controller.signal.aborted) {
          setSelectedScopedBinaryFieldFrame(nextFrame);
        }
      })
      .catch(() => {
        // Keep the last valid scoped frame visible while a replacement frame is unavailable.
      });
    return () => controller.abort();
  }, [
    activeQuantityId,
    femMesh,
    liveApi,
    scopedFemVectorScopes,
    scopedFieldTransportKey,
    selectedFieldFrame,
  ]);

  const authoredField = authoredMagnetizationPreview?.vectors ?? null;
  const selectedLiveField = resolveSelectedLiveField({
    activeQuantityId,
    fieldMap,
    selectedScopedBinaryFieldFrame,
    scopedFieldTransportKey,
    selectedFieldTopologyMismatch,
    selectedBinaryFieldFrame,
    selectedFieldTransportKey,
  });
  const selectedVectorSource = useMemo(() => {
    return selectViewportVectorField({
      activeQuantityId,
      requestedPreviewQuantity,
      previewControlsActive,
      renderPreview,
      authoredField,
      liveField: selectedLiveField,
      liveFieldSourceStep,
      previewSourceStep,
      isGlobalScalarQuantity,
      skipPreviewFallback: effectiveIsFemBackend && effectiveViewMode === "3D" && Boolean(selectedLiveField),
    });
  }, [
    activeQuantityId,
    authoredField,
    effectiveIsFemBackend,
    effectiveViewMode,
    isGlobalScalarQuantity,
    liveFieldSourceStep,
    previewControlsActive,
    previewSourceStep,
    renderPreview,
    requestedPreviewQuantity,
    selectedLiveField,
  ]);
  const selectedVectors = selectedVectorSource.vectors;
  const fieldDataRevision = useMemo(() => {
    if (authoredMagnetizationPreview?.vectors && selectedVectors === authoredMagnetizationPreview.vectors) {
      return authoredMagnetizationPreview.revision;
    }
    if (!selectedFieldFrame || !selectedVectors?.length) {
      if (
        selectedVectorSource.source === "preview" &&
        renderPreview?.source_step != null
      ) {
        return [
          "preview",
          activeQuantityId,
          renderPreview.config_revision,
          renderPreview.source_step,
          renderPreview.source_time,
          renderPreview.vector_field_values ? fieldFrameIdentity(renderPreview.vector_field_values) : "none",
        ].join(":");
      }
      return null;
    }
    const canonicalFieldRevision =
      selectedFieldFrame.field_revision
      ?? selectedFieldFrame.source_step
      ?? null;
    return [
      "frame",
      selectedFieldFrame.quantity_id,
      selectedFieldFrame.n_comp,
      selectedVectors.length,
      canonicalFieldRevision ?? "none",
      selectedFieldFrame.source_time ?? "none",
      fieldFrameIdentity(selectedVectors),
    ].join(":");
  }, [
    activeQuantityId,
    authoredMagnetizationPreview,
    renderPreview?.config_revision,
    renderPreview?.source_step,
    renderPreview?.source_time,
    renderPreview?.vector_field_values,
    selectedFieldFrame,
    selectedVectorSource.source,
    selectedVectors,
  ]);
  if (fieldDataRevision && fieldDataRevision !== lastFieldDataRevisionRef.current) {
    lastFieldDataRevisionRef.current = fieldDataRevision;
    fieldDataTimestampRef.current = Date.now();
  }
  const fieldDataTimestamp = fieldDataTimestampRef.current;

  useEffect(() => {
    if (!activeQuantityId || !fieldDataRevision) {
      return;
    }
    const traceKey = `${activeQuantityId}|${fieldDataRevision}|${selectedVectorSource.source}`;
    if (lastQuantitySwitchTraceKeyRef.current === traceKey) {
      return;
    }
    lastQuantitySwitchTraceKeyRef.current = traceKey;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const latestRequest = [...getFrontendPerfSamples()]
      .reverse()
      .find(
        (sample) =>
          sample.scope === "QuantitySwitch" &&
          sample.phase === "request" &&
          sample.meta?.quantity === activeQuantityId,
      );
    const fromRequestMs =
      latestRequest && Number.isFinite(latestRequest.timestampMs)
        ? Math.max(0, now - latestRequest.timestampMs)
        : 0;
    const cacheState =
      selectedFieldTopologyMismatch
        ? "topology-mismatch"
        : selectedBinaryFieldFrame?.key === selectedFieldTransportKey
          ? "binary-hit"
          : selectedFieldFrame
            ? "field-map-hit"
            : selectedVectorSource.source === "preview"
              ? "preview-recompute"
              : "none";
    recordFrontendPerfSample({
      scope: "QuantitySwitch",
      phase: "field-selected",
      durationMs: fromRequestMs,
      timestampMs: now,
      meta: {
        quantity: activeQuantityId,
        source: selectedVectorSource.source,
        cacheState,
        vectorLength: selectedVectors?.length ?? 0,
      },
    });
    const raf = window.requestAnimationFrame(() => {
      const renderedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      recordFrontendPerfSample({
        scope: "QuantitySwitch",
        phase: "frame-rendered",
        durationMs:
          latestRequest && Number.isFinite(latestRequest.timestampMs)
            ? Math.max(0, renderedAt - latestRequest.timestampMs)
            : 0,
        timestampMs: renderedAt,
        meta: {
          quantity: activeQuantityId,
          source: selectedVectorSource.source,
          cacheState,
        },
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [
    activeQuantityId,
    fieldDataRevision,
    selectedBinaryFieldFrame?.key,
    selectedFieldFrame,
    selectedFieldTopologyMismatch,
    selectedFieldTransportKey,
    selectedVectorSource.source,
    selectedVectors,
  ]);

  useEffect(() => {
    if (!debugLogsEnabled) {
      return;
    }
    if (!fieldDataRevision || !selectedVectors?.length) {
      return;
    }
    console.info("[fullmag-debug][viewport-data] vector payload selected", {
      source: selectedVectorSource.source,
      quantity: activeQuantityId,
      effectiveStep,
      liveFieldSourceStep,
      previewSourceStep,
      vectorLength: selectedVectors.length,
      vectorIdentity: fieldFrameIdentity(selectedVectors),
      vectorHead: vectorHead(selectedVectors),
      previewGrid: renderPreview?.preview_grid ?? null,
    });
  }, [
    activeQuantityId,
    debugLogsEnabled,
    effectiveStep,
    fieldDataRevision,
    liveFieldSourceStep,
    previewSourceStep,
    renderPreview?.preview_grid,
    selectedVectorSource.source,
    selectedVectors,
  ]);

  return {
    fieldDataRevision,
    fieldDataTimestamp,
    liveFieldSourceStep,
    previewSourceStep,
    scopedActiveMask: selectedScopedBinaryFieldFrame?.activeMask ?? null,
    selectedFieldDomain,
    selectedFieldNComp,
    selectedVectors,
    selectedVectorSource,
  };
}
