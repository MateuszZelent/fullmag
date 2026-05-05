import { isStudyNodeId } from "@/lib/study-builder/node-context";
import type { SpatialPreviewState } from "@/lib/session/types";

export function resolveViewportSelectedObjectId(args: {
  selectedObjectId: string | null;
  selectedSidebarNodeId: string | null;
  stickyObjectId: string | null;
}): string | null {
  const { selectedObjectId, selectedSidebarNodeId, stickyObjectId } = args;
  if (selectedObjectId) {
    return selectedObjectId;
  }
  if (stickyObjectId && isStudyNodeId(selectedSidebarNodeId)) {
    return stickyObjectId;
  }
  return null;
}

export function selectViewportVectorField(args: {
  activeQuantityId: string | null;
  requestedPreviewQuantity: string | null;
  previewControlsActive: boolean;
  renderPreview: SpatialPreviewState | null;
  authoredField?: Float64Array | null;
  liveField: Float64Array | null;
  liveFieldSourceStep?: number | null;
  previewSourceStep?: number | null;
  isGlobalScalarQuantity: (quantity: string | null | undefined) => boolean;
  /** When true, never fall back to preview vectors. Use in FEM 3D once live
   * data is active or expected so stale preview frames cannot flicker back in. */
  skipPreviewFallback?: boolean;
}): {
  vectors: Float64Array | null;
  source: "authored" | "preview" | "live" | "none";
} {
  const {
    activeQuantityId,
    requestedPreviewQuantity,
    previewControlsActive,
    renderPreview,
    authoredField = null,
    liveField,
    liveFieldSourceStep = null,
    previewSourceStep = null,
    isGlobalScalarQuantity,
    skipPreviewFallback = false,
  } = args;

  if (isGlobalScalarQuantity(activeQuantityId)) {
    return { vectors: null, source: "none" };
  }

  if (authoredField && authoredField.length > 0) {
    return { vectors: authoredField, source: "authored" };
  }

  if (skipPreviewFallback) {
    if (liveField && liveField.length > 0) {
      return { vectors: liveField, source: "live" };
    }
    return { vectors: null, source: "none" };
  }

  const previewVectors = renderPreview?.vector_field_values ?? null;
  const previewRepresentsActiveQuantity =
    activeQuantityId != null &&
    previewControlsActive &&
    requestedPreviewQuantity === activeQuantityId &&
    (
      renderPreview?.quantity === activeQuantityId ||
      !renderPreview?.quantity ||
      renderPreview.quantity.length === 0
    );

  const liveFieldIsAtLeastAsFresh =
    liveFieldSourceStep != null &&
    (
      previewSourceStep == null ||
      liveFieldSourceStep >= previewSourceStep
    );

  if (liveFieldIsAtLeastAsFresh && liveField && liveField.length > 0) {
    return { vectors: liveField, source: "live" };
  }

  if (previewRepresentsActiveQuantity && previewVectors && previewVectors.length > 0) {
    return { vectors: previewVectors, source: "preview" };
  }

  if (liveField && liveField.length > 0) {
    return { vectors: liveField, source: "live" };
  }

  return { vectors: null, source: "none" };
}
