/**
 * Toolbar-derived model hook.
 *
 * Computes all toolbar-scoped derived state from the viewport model
 * (part selection, render mode, opacity, color field, arrow state, etc.).
 * Extracted from FemMeshView3D.tsx to reduce file size.
 */

import { useMemo } from "react";
import type {
  FemColorField,
  FemArrowColorMode,
  FemMeshData,
  RenderMode,
  RenderLayer,
} from "./femMeshTypes";
import type { MeshEntityViewState, FemMeshPart } from "../../../lib/session/types";
import { SUPPORTED_ARROW_COLOR_FIELDS } from "./femGeometryUtils";
import { computeArrowRenderState } from "./arrowRenderState";
import type { ArrowRenderState, ArrowToolbarState } from "./arrowRenderState";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import {
  resolveViewportSelectionScope,
  scopeLabel,
  type ViewportSelectionScope,
} from "@/features/viewport-fem/model/femViewportSelection";

interface UseFemToolbarModelArgs {
  hasMeshParts: boolean;
  meshParts: FemMeshPart[];
  visibleLayers: RenderLayer[];
  baseViewStateByPartId: Map<string, MeshEntityViewState>;
  renderMode: RenderMode;
  field: FemColorField;
  opacity: number;
  arrowColorMode: FemArrowColorMode;
  showArrows: boolean;
  missingMagneticMask: boolean;
  visibleArrowNodeCount: number;
  meshData: FemMeshData;
  baseArrowDensity: number;
  effectiveArrowDensity: number;
  qualityPerFace?: number[] | null;
  fieldLabel?: string;
  /** Final sampled arrow count reported back from FemArrows (after density filtering). */
  sampledArrowCount?: number;
  quantityOptions?: Array<{
    id: string;
    shortLabel: string;
    label?: string;
    available: boolean;
  }>;
  selectedObjectId?: string | null;
  selectedEntityId?: string | null;
}

export interface FemToolbarModel {
  selectionScope: ViewportSelectionScope;
  toolbarStylePartIds: string[];
  toolbarStylePartIdSet: Set<string>;
  toolbarColorPartIds: string[];
  toolbarRenderMode: RenderMode;
  toolbarRenderModeMixed: boolean;
  toolbarRepresentativePartId: string | null;
  toolbarOpacity: number;
  toolbarOpacityMixed: boolean;
  toolbarColorFieldMixed: boolean;
  toolbarColorField: FemColorField;
  prominentQuantityOptions: Array<{
    id: string;
    shortLabel: string;
    label?: string;
    available: boolean;
  }>;
  arrowField: FemColorField;
  legendField: FemColorField;
  arrowRenderState: ArrowRenderState;
  effectiveShowArrows: boolean;
  arrowsBlockReason: string | null;
  arrowToolbarState: ArrowToolbarState;
  toolbarScopeLabel: string | null;
  fieldMagnitudeStats: { min: number; max: number; mean: number } | null;
}

export function useFemToolbarModel({
  hasMeshParts,
  meshParts,
  visibleLayers,
  baseViewStateByPartId,
  renderMode,
  field,
  opacity,
  arrowColorMode,
  showArrows,
  missingMagneticMask,
  visibleArrowNodeCount,
  meshData,
  baseArrowDensity,
  effectiveArrowDensity,
  qualityPerFace,
  sampledArrowCount,
  quantityOptions = [],
  selectedObjectId = null,
  selectedEntityId = null,
}: UseFemToolbarModelArgs): FemToolbarModel {
  // P1-1: Resolve canonical selection scope from the viewport model
  const selectionScope = useMemo<ViewportSelectionScope>(
    () =>
      resolveViewportSelectionScope({
        selectedSidebarNodeId: null, // not available inside viewport
        selectedObjectId,
        selectedEntityId,
        meshParts,
      }),
    [meshParts, selectedEntityId, selectedObjectId],
  );

  // D-01 fix: Collect ALL selected layers for the toolbar scope,
  // not just the first one. For composite objects with multiple submeshes,
  // the toolbar must target all parts belonging to the selected object.
  const toolbarStylePartIds = useMemo(() => {
    if (!hasMeshParts) {
      return [] as string[];
    }
    const selectedLayers = visibleLayers.filter((layer) => layer.isSelected);
    if (selectedLayers.length > 0) {
      return selectedLayers.map((layer) => layer.part.id);
    }
    return visibleLayers.map((layer) => layer.part.id);
  }, [hasMeshParts, visibleLayers]);

  const toolbarStylePartIdSet = useMemo(
    () => new Set(toolbarStylePartIds),
    [toolbarStylePartIds],
  );

  const toolbarColorPartIds = useMemo(() => {
    if (!hasMeshParts) {
      return [] as string[];
    }
    const magneticIds = visibleLayers
      .filter(
        (layer) =>
          toolbarStylePartIdSet.has(layer.part.id) && layer.part.role === "magnetic_object",
      )
      .map((layer) => layer.part.id);
    if (magneticIds.length > 0) {
      return magneticIds;
    }
    const nonAirIds = visibleLayers
      .filter((layer) => toolbarStylePartIdSet.has(layer.part.id) && layer.part.role !== "air")
      .map((layer) => layer.part.id);
    return nonAirIds.length > 0 ? nonAirIds : toolbarStylePartIds;
  }, [hasMeshParts, toolbarStylePartIdSet, toolbarStylePartIds, visibleLayers]);

  const toolbarRenderMode = useMemo(() => {
    if (!hasMeshParts || toolbarStylePartIds.length === 0) {
      return renderMode;
    }
    const values = Array.from(
      new Set(
        toolbarStylePartIds
          .map((partId) => baseViewStateByPartId.get(partId)?.renderMode)
          .filter((value): value is RenderMode => Boolean(value)),
      ),
    );
    if (values.length === 1) {
      return values[0] ?? renderMode;
    }
    return renderMode;
  }, [baseViewStateByPartId, hasMeshParts, renderMode, toolbarStylePartIds]);

  const toolbarRenderModeMixed = useMemo(() => {
    if (!hasMeshParts || toolbarStylePartIds.length <= 1) return false;
    const modes = new Set(
      toolbarStylePartIds
        .map((id) => baseViewStateByPartId.get(id)?.renderMode)
        .filter(Boolean),
    );
    return modes.size > 1;
  }, [baseViewStateByPartId, hasMeshParts, toolbarStylePartIds]);

  const toolbarRepresentativePartId = useMemo(() => {
    if (!hasMeshParts || toolbarStylePartIds.length === 0) {
      return null;
    }
    const targetLayers = visibleLayers.filter((layer) => toolbarStylePartIdSet.has(layer.part.id));
    const magneticId = targetLayers.find((layer) => layer.part.role === "magnetic_object")?.part.id;
    if (magneticId) {
      return magneticId;
    }
    const nonAirId = targetLayers.find((layer) => layer.part.role !== "air")?.part.id;
    return nonAirId ?? targetLayers[0]?.part.id ?? null;
  }, [hasMeshParts, toolbarStylePartIdSet, toolbarStylePartIds.length, visibleLayers]);

  const toolbarOpacity = useMemo(() => {
    if (!hasMeshParts || !toolbarRepresentativePartId) {
      return opacity;
    }
    return baseViewStateByPartId.get(toolbarRepresentativePartId)?.opacity ?? opacity;
  }, [baseViewStateByPartId, hasMeshParts, opacity, toolbarRepresentativePartId]);

  const toolbarOpacityMixed = useMemo(() => {
    if (!hasMeshParts || toolbarStylePartIds.length <= 1) return false;
    const values = new Set(
      toolbarStylePartIds
        .map((id) => baseViewStateByPartId.get(id)?.opacity)
        .filter((v): v is number => v != null),
    );
    return values.size > 1;
  }, [baseViewStateByPartId, hasMeshParts, toolbarStylePartIds]);

  const toolbarColorFieldMixed = useMemo(() => {
    if (!hasMeshParts || toolbarColorPartIds.length <= 1) return false;
    const values = new Set(
      toolbarColorPartIds
        .map((id) => baseViewStateByPartId.get(id)?.colorField)
        .filter(Boolean),
    );
    return values.size > 1;
  }, [baseViewStateByPartId, hasMeshParts, toolbarColorPartIds]);

  const toolbarColorField = useMemo(() => {
    if (!hasMeshParts || toolbarColorPartIds.length === 0) {
      return field;
    }
    const values = Array.from(
      new Set(
        toolbarColorPartIds
          .map((partId) => baseViewStateByPartId.get(partId)?.colorField)
          .filter((value): value is FemColorField => Boolean(value)),
      ),
    );
    if (values.length === 1) {
      return values[0] ?? field;
    }
    return field;
  }, [baseViewStateByPartId, field, hasMeshParts, toolbarColorPartIds]);

  const prominentQuantityOptions = useMemo(
    () => quantityOptions.filter((option) => option.available),
    [quantityOptions],
  );

  const arrowField: FemColorField =
    arrowColorMode === "monochrome"
      ? "orientation"
      : SUPPORTED_ARROW_COLOR_FIELDS.has(arrowColorMode)
        ? (arrowColorMode as FemColorField)
        : "orientation";

  // D-01 fix: Use toolbar scope parts for legend field, not just first selected
  const legendField = hasMeshParts
    ? (() => {
        // Prefer magnetic parts within the toolbar scope for the legend
        const scopePartIds = toolbarStylePartIdSet;
        const scopedMagneticPartId = visibleLayers.find(
          (layer) => layer.isMagnetic && scopePartIds.has(layer.part.id),
        )?.part.id;
        if (scopedMagneticPartId) {
          const magneticField = baseViewStateByPartId.get(scopedMagneticPartId)?.colorField;
          if (magneticField) {
            return magneticField;
          }
        }
        // Fallback to any magnetic layer
        const magneticPartId = visibleLayers.find((layer) => layer.isMagnetic)?.part.id ?? null;
        if (magneticPartId) {
          const magneticField = baseViewStateByPartId.get(magneticPartId)?.colorField;
          if (magneticField) {
            return magneticField;
          }
        }
        return toolbarColorField;
      })()
    : toolbarColorField;

  // Compute directly (no useMemo) because FRONTEND_DIAGNOSTIC_FLAGS is a
  // mutable singleton that cannot participate in React dependency arrays.
  const baseArrowRenderState: ArrowRenderState = computeArrowRenderState({
    requested: showArrows && !FRONTEND_DIAGNOSTIC_FLAGS.femViewport.forceHideArrows,
    layerEnabled: FRONTEND_DIAGNOSTIC_FLAGS.femViewport.showArrowLayer,
    missingMagneticMask,
    visibleNodeCount: visibleArrowNodeCount,
    hasFieldData: Boolean(meshData.fieldData),
  });

  // Refine: if base state says visible but FemArrows reports zero sampled
  // nodes, override to no_sampled_nodes so the toolbar shows the correct reason.
  const arrowRenderState: ArrowRenderState =
    baseArrowRenderState.visible &&
    sampledArrowCount != null &&
    sampledArrowCount === 0
      ? { ...baseArrowRenderState, visible: false, reason: "no_sampled_nodes" }
      : baseArrowRenderState;

  const effectiveShowArrows = arrowRenderState.visible;

  const arrowsBlockReason = useMemo<string | null>(() => {
    if (!showArrows) return null;
    switch (arrowRenderState.reason) {
      case "layer_disabled":
        return "Arrow layer is disabled via diagnostic flags";
      case "missing_field":
        return "No magnetic field data available for vector display";
      case "no_visible_nodes":
        return "No visible nodes match current vector domain filter";
      case "no_sampled_nodes":
        return "Density sampling produced zero arrows — increase arrow density";
      default:
        return null;
    }
  }, [arrowRenderState.reason, showArrows]);

  const arrowToolbarState = useMemo<ArrowToolbarState>(
    () => ({
      requested: arrowRenderState.requested,
      visible: arrowRenderState.visible,
      reason: arrowRenderState.reason,
      density: baseArrowDensity,
      effectiveDensity: effectiveArrowDensity,
    }),
    [arrowRenderState, baseArrowDensity, effectiveArrowDensity],
  );

  // P1-1: Use canonical resolveViewportSelectionScope for scope label
  const toolbarScopeLabel = useMemo<string | null>(() => {
    if (!hasMeshParts || toolbarStylePartIds.length === 0) return null;
    return scopeLabel(selectionScope, meshParts);
  }, [hasMeshParts, meshParts, selectionScope, toolbarStylePartIds]);

  const fieldMagnitudeStats = useMemo(() => {
    if (
      (legendField === "quality" || legendField === "sicn") &&
      qualityPerFace &&
      qualityPerFace.length > 0
    ) {
      const values = qualityPerFace.filter((value) => Number.isFinite(value));
      if (values.length === 0) {
        return null;
      }
      const sum = values.reduce((acc, value) => acc + value, 0);
      return {
        min: Math.min(...values),
        max: Math.max(...values),
        mean: sum / values.length,
      };
    }
    if (!meshData.fieldData || meshData.nNodes === 0) {
      return null;
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    for (let index = 0; index < meshData.nNodes; index += 1) {
      const x = meshData.fieldData.x[index] ?? 0;
      const y = meshData.fieldData.y[index] ?? 0;
      const z = meshData.fieldData.z[index] ?? 0;
      const value =
        legendField === "x"
          ? x
          : legendField === "y"
            ? y
            : legendField === "z"
              ? z
              : legendField === "magnitude" || legendField === "orientation"
                ? Math.hypot(x, y, z)
                : 0;
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return null;
    }
    return { min, max, mean: sum / meshData.nNodes };
  }, [legendField, meshData.fieldData, meshData.nNodes, qualityPerFace]);

  return {
    selectionScope,
    toolbarStylePartIds,
    toolbarStylePartIdSet,
    toolbarColorPartIds,
    toolbarRenderMode,
    toolbarRenderModeMixed,
    toolbarRepresentativePartId,
    toolbarOpacity,
    toolbarOpacityMixed,
    toolbarColorFieldMixed,
    toolbarColorField,
    prominentQuantityOptions,
    arrowField,
    legendField,
    arrowRenderState,
    effectiveShowArrows,
    arrowsBlockReason,
    arrowToolbarState,
    toolbarScopeLabel,
    fieldMagnitudeStats,
  };
}
