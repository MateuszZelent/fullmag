import { useCallback, useMemo } from "react";
import type {
  CurrentDisplaySelection,
  DisplaySelection,
  PreviewState,
  QuantityDescriptor,
} from "@/lib/session/types";
import {
  PREVIEW_EVERY_N_DEFAULT,
  PREVIEW_EVERY_N_PRESETS,
  PREVIEW_MAX_POINTS_DEFAULT,
  PREVIEW_MAX_POINTS_PRESETS,
} from "../shared";
import type { VectorComponent, ViewportMode } from "../shared";
import type { FieldStats } from "../types";
import {
  buildRequestedDisplaySelection,
  previewComponentFromDisplaySelection,
} from "../helpers";

export interface UsePreviewDerivedParams {
  displaySelection: CurrentDisplaySelection | null;
  previewConfig: {
    quantity?: string;
    component?: string;
    layer?: number;
    all_layers?: boolean;
    every_n?: number;
    max_points?: number;
    x_chosen_size?: number;
    y_chosen_size?: number;
    auto_scale_enabled?: boolean;
    revision?: number;
  } | null;
  preview: PreviewState | null;
  spatialPreview: (PreviewState & { kind: "spatial" }) | null;
  globalScalarPreview: (PreviewState & { kind: "global_scalar" }) | null;
  optimisticDisplaySelection: DisplaySelection | null;
  previewPostInFlight: boolean;
  selectedQuantity: string;
  component: VectorComponent;
  quantityDescriptorById: Map<string, QuantityDescriptor>;
  femDiscretization: boolean;
  effectiveStep: number;
  fieldMap: Record<string, Float64Array | null>;
}

export function usePreviewDerived({
  displaySelection,
  previewConfig,
  preview,
  spatialPreview,
  globalScalarPreview,
  optimisticDisplaySelection,
  previewPostInFlight,
  selectedQuantity,
  component,
  quantityDescriptorById,
  femDiscretization,
  effectiveStep,
  fieldMap,
}: UsePreviewDerivedParams) {
  const kindForQuantity = useCallback((quantity: string): DisplaySelection["kind"] => {
    const desc = quantityDescriptorById.get(quantity);
    if (!desc) return "vector_field";
    switch (desc.kind) {
      case "spatial_scalar":
        return "spatial_scalar";
      case "global_scalar":
        return "global_scalar";
      default:
        return "vector_field";
    }
  }, [quantityDescriptorById]);

  const isGlobalScalarQuantity = useCallback(
    (quantity: string | null | undefined) =>
      Boolean(quantity && quantityDescriptorById.get(quantity)?.kind === "global_scalar"),
    [quantityDescriptorById],
  );

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
  const activeQuantityId =
    previewControlsActive
      ? (previewIsStale ? requestedPreviewQuantity : (preview?.quantity ?? requestedPreviewQuantity))
      : selectedQuantity;
  const isMeshPreview = renderPreview?.spatial_kind === "mesh";
  const previewVectorComponent: VectorComponent =
    renderPreview?.component && renderPreview.component !== "3D"
      ? (renderPreview.component as VectorComponent)
      : "magnitude";

  const renderPreviewMatchesActiveQuantity = renderPreview?.quantity === activeQuantityId;

  const selectedVectors = useMemo(() => {
    if (isGlobalScalarQuantity(activeQuantityId)) return null;
    const liveField = fieldMap[activeQuantityId] ?? null;
    if (femDiscretization && liveField && liveField.length > 0) {
      return liveField;
    }
    if (renderPreviewMatchesActiveQuantity && renderPreview?.vector_field_values) {
      return renderPreview.vector_field_values;
    }
    return liveField;
  }, [
    activeQuantityId,
    fieldMap,
    femDiscretization,
    isGlobalScalarQuantity,
    renderPreviewMatchesActiveQuantity,
    renderPreview?.vector_field_values,
  ]);

  const quantityDescriptor = useMemo(
    () => (activeQuantityId ? quantityDescriptorById.get(activeQuantityId) ?? null : null),
    [activeQuantityId, quantityDescriptorById],
  );
  const hasVectorData = Boolean(selectedVectors && selectedVectors.length > 0);
  const isVectorQuantity =
    requestedDisplaySelection.kind === "vector_field" ||
    quantityDescriptor?.kind === "vector_field" ||
    (!isGlobalScalarQuantity(activeQuantityId) && hasVectorData);

  const selectedScalarValue = useMemo(() => {
    return globalScalarPreview?.value ?? null;
  }, [globalScalarPreview]);
  const selectedQuantityLabel = quantityDescriptor?.label ?? requestedPreviewQuantity;
  const selectedQuantityUnit = quantityDescriptor?.unit ?? null;

  return {
    kindForQuantity,
    isGlobalScalarQuantity,
    requestedDisplaySelection,
    previewControlsActive,
    requestedPreviewQuantity,
    requestedPreviewComponent,
    requestedPreviewLayer,
    requestedPreviewAllLayers,
    requestedPreviewEveryN,
    requestedPreviewXChosenSize,
    requestedPreviewYChosenSize,
    requestedPreviewAutoScale,
    requestedPreviewMaxPoints,
    previewEveryNOptions,
    previewMaxPointOptions,
    previewIsStale,
    previewIsInitialSampleStale,
    previewBusy,
    previewMessage: null as string | null,
    renderPreview,
    activeQuantityId,
    isMeshPreview,
    previewVectorComponent,
    effectiveVectorComponent: isMeshPreview ? previewVectorComponent : component,
    selectedVectors,
    quantityDescriptor,
    isVectorQuantity,
    selectedScalarValue,
    selectedQuantityLabel,
    selectedQuantityUnit,
    renderPreviewMatchesActiveQuantity,
  };
}
