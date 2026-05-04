import { useCallback, useMemo } from "react";
import type {
  DisplaySelection,
  CurrentDisplaySelection,
  FemLiveMesh,
  LatestFieldFrame,
  PreviewConfig,
  PreviewState,
  QuantityDescriptor,
  SpatialPreviewState,
} from "@/lib/session/types";
import type {
  VectorComponent,
  ViewportMode,
} from "../shared";
import {
  PREVIEW_EVERY_N_PRESETS,
  PREVIEW_MAX_POINTS_PRESETS,
} from "../shared";
import {
  buildRequestedDisplaySelection,
  previewComponentFromDisplaySelection,
} from "../helpers";

export function usePreviewSelectionState({
  component,
  displaySelection,
  effectiveStep,
  optimisticDisplaySelection,
  preview,
  previewConfig,
  previewPostInFlight,
  quantityDescriptorById,
  runtimeFemMesh,
  runtimeLatestFieldFrames,
  selectedQuantity,
  spatialPreview,
  viewMode,
  kindForQuantity,
}: {
  component: VectorComponent;
  displaySelection: CurrentDisplaySelection | null;
  effectiveStep: number;
  optimisticDisplaySelection: DisplaySelection | null;
  preview: PreviewState | null;
  previewConfig: PreviewConfig | null;
  previewPostInFlight: boolean;
  quantityDescriptorById: Map<string, QuantityDescriptor>;
  runtimeFemMesh: FemLiveMesh | null;
  runtimeLatestFieldFrames: Record<string, LatestFieldFrame>;
  selectedQuantity: string;
  spatialPreview: SpatialPreviewState | null;
  viewMode: ViewportMode;
  kindForQuantity: (quantity: string) => DisplaySelection["kind"];
}) {
  const effectiveViewMode = viewMode;
  const requestedDisplaySelection = useMemo<DisplaySelection>(() => {
    return buildRequestedDisplaySelection({
      optimisticDisplaySelection,
      displaySelection,
      previewConfig,
      preview,
      spatialPreview,
      kindForQuantity,
    });
  }, [displaySelection, kindForQuantity, optimisticDisplaySelection, preview, previewConfig, spatialPreview]);
  const currentPreviewRevision = displaySelection?.revision ?? previewConfig?.revision ?? null;
  const previewControlsActive = Boolean(displaySelection ?? previewConfig ?? preview);
  const requestedPreviewQuantity = requestedDisplaySelection.quantity;
  const requestedPreviewComponent =
    previewComponentFromDisplaySelection(requestedDisplaySelection);
  const requestedPreviewLayer = requestedDisplaySelection.layer;
  const requestedPreviewAllLayers = requestedDisplaySelection.all_layers;
  const requestedPreviewEveryN = requestedDisplaySelection.every_n;
  const requestedPreviewXChosenSize = requestedDisplaySelection.x_chosen_size;
  const requestedPreviewYChosenSize = requestedDisplaySelection.y_chosen_size;
  const requestedPreviewAutoScale = requestedDisplaySelection.auto_scale_enabled;
  const requestedPreviewMaxPoints = requestedDisplaySelection.max_points;

  const previewEveryNOptions = useMemo(
    () => Array.from(new Set([...PREVIEW_EVERY_N_PRESETS, requestedPreviewEveryN])).sort((a, b) => a - b),
    [requestedPreviewEveryN],
  );
  const previewMaxPointOptions = useMemo(() => {
    const values = new Set<number>([...PREVIEW_MAX_POINTS_PRESETS, requestedPreviewMaxPoints]);
    return Array.from(values).sort((a, b) => { if (a === 0) return 1; if (b === 0) return -1; return a - b; });
  }, [requestedPreviewMaxPoints]);

  const isGlobalScalarQuantity = useCallback(
    (quantity: string | null | undefined) =>
      Boolean(quantity && quantityDescriptorById.get(quantity)?.kind === "global_scalar"),
    [quantityDescriptorById],
  );
  const previewIsStale = Boolean(
    preview &&
    currentPreviewRevision != null &&
    preview.config_revision !== currentPreviewRevision,
  );
  const previewIsInitialSampleStale = Boolean(
    previewControlsActive && preview && effectiveStep > 0 && preview.source_step === 0,
  );
  const displaySelectionPending = optimisticDisplaySelection != null;
  const previewBusy = previewPostInFlight || displaySelectionPending;
  const renderPreview = spatialPreview;
  const activeQuantityId = selectedQuantity;
  const isMeshPreview = renderPreview?.spatial_kind === "mesh";
  const previewVectorComponent: VectorComponent =
    renderPreview?.component && renderPreview.component !== "3D"
      ? (renderPreview.component as VectorComponent)
      : "magnitude";
  const effectiveVectorComponent = isMeshPreview ? previewVectorComponent : component;

  const activeFemGenerationSignature = useMemo(() => {
    if (!runtimeFemMesh?.generation_id || runtimeFemMesh.generation_id.length === 0) {
      return null;
    }
    return `gen:${runtimeFemMesh.generation_id}`;
  }, [runtimeFemMesh?.generation_id]);
  const cachedFieldQuantities = useMemo<ReadonlySet<string>>(() => {
    const frames = runtimeLatestFieldFrames;
    if (!frames) return new Set<string>();
    const next = new Set<string>();
    for (const [quantityId, frame] of Object.entries(frames)) {
      if (
        activeFemGenerationSignature &&
        frame.topology_signature &&
        frame.topology_signature.startsWith("gen:") &&
        frame.topology_signature !== activeFemGenerationSignature
      ) {
        continue;
      }
      next.add(quantityId);
    }
    return next;
  }, [activeFemGenerationSignature, runtimeLatestFieldFrames]);

  return {
    activeFemGenerationSignature,
    activeQuantityId,
    cachedFieldQuantities,
    currentPreviewRevision,
    displaySelectionPending,
    effectiveVectorComponent,
    effectiveViewMode,
    isGlobalScalarQuantity,
    isMeshPreview,
    previewBusy,
    previewControlsActive,
    previewEveryNOptions,
    previewIsInitialSampleStale,
    previewIsStale,
    previewMaxPointOptions,
    requestedDisplaySelection,
    requestedPreviewAllLayers,
    requestedPreviewAutoScale,
    requestedPreviewComponent,
    requestedPreviewEveryN,
    requestedPreviewLayer,
    requestedPreviewMaxPoints,
    requestedPreviewQuantity,
    requestedPreviewXChosenSize,
    requestedPreviewYChosenSize,
    renderPreview,
  };
}
