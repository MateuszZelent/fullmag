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
  liveField: Float64Array | null;
  isGlobalScalarQuantity: (quantity: string | null | undefined) => boolean;
}): {
  vectors: Float64Array | null;
  source: "preview" | "live" | "none";
} {
  const {
    activeQuantityId,
    requestedPreviewQuantity,
    previewControlsActive,
    renderPreview,
    liveField,
    isGlobalScalarQuantity,
  } = args;

  if (isGlobalScalarQuantity(activeQuantityId)) {
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

  if (previewRepresentsActiveQuantity && previewVectors && previewVectors.length > 0) {
    return { vectors: previewVectors, source: "preview" };
  }

  if (liveField && liveField.length > 0) {
    return { vectors: liveField, source: "live" };
  }

  return { vectors: null, source: "none" };
}
