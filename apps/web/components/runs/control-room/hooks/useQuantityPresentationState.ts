import { useEffect, useMemo } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  QuantityDescriptor,
  ScalarRow,
  SpatialPreviewState,
} from "@/lib/session/types";
import type { QuantityDataStatus } from "../context-hooks";
import {
  formatQuantityOptionLabel,
  isQuantitySelectable,
} from "../controlRoomContextHelpers";

export function useQuantityPresentationState({
  cachedFieldQuantities,
  quantities,
  renderPreview,
  requestedPreviewQuantity,
  scalarRows,
  selectedQuantity,
  setSelectedQuantity,
}: {
  cachedFieldQuantities: ReadonlySet<string>;
  quantities: QuantityDescriptor[];
  renderPreview: SpatialPreviewState | null | undefined;
  requestedPreviewQuantity: string;
  scalarRows: ScalarRow[];
  selectedQuantity: string;
  setSelectedQuantity: Dispatch<SetStateAction<string>>;
}) {
  const eTotalSpark = useMemo(
    () => scalarRows.slice(-40).map((row) => row.e_total ?? 0),
    [scalarRows],
  );
  const dmDtSpark = useMemo(
    () => scalarRows.slice(-40).map((row) => Math.log10(Math.max(row.max_dm_dt ?? 1e-15, 1e-15))),
    [scalarRows],
  );
  const dtSpark = useMemo(
    () => scalarRows.slice(-40).map((row) => row.solver_dt ?? 0),
    [scalarRows],
  );

  const quantityDataStatusById = useMemo(() => {
    const previewHasData = Boolean(
      renderPreview?.vector_field_values && renderPreview.vector_field_values.length > 0,
    );
    const previewQuantity =
      previewHasData && renderPreview?.quantity && renderPreview.quantity.length > 0
        ? renderPreview.quantity
        : previewHasData
          ? requestedPreviewQuantity
          : null;

    return new Map(
      quantities.map((quantity) => {
        let status: QuantityDataStatus = "pending";
        if (!isQuantitySelectable(quantity)) {
          status = "unsupported";
        } else if (quantity.data_available || cachedFieldQuantities.has(quantity.id)) {
          status = "ready";
        } else if (previewQuantity === quantity.id) {
          status = "preview";
        }
        return [quantity.id, status] as const;
      }),
    );
  }, [
    cachedFieldQuantities,
    quantities,
    renderPreview?.quantity,
    renderPreview?.vector_field_values,
    requestedPreviewQuantity,
  ]);

  const requestedPreviewQuantityDataStatus =
    quantityDataStatusById.get(requestedPreviewQuantity) ?? "pending";
  const quantityOptions = useMemo(
    () => quantities.map((quantity) => ({
      value: quantity.id,
      label: formatQuantityOptionLabel(quantity),
      disabled: !isQuantitySelectable(quantity),
    })),
    [quantities],
  );
  const previewQuantityOptions = useMemo(
    () => quantities
      .filter((quantity) => quantity.interactive_preview && quantity.supports_preview_3d)
      .map((quantity) => ({
        value: quantity.id,
        label: formatQuantityOptionLabel(quantity),
        disabled: !isQuantitySelectable(quantity),
      })),
    [quantities],
  );

  useEffect(() => {
    if (!quantityOptions.length) return;
    if (!quantityOptions.some((option) => option.value === selectedQuantity)) {
      const fallback = quantityOptions.find((option) => !option.disabled) ?? quantityOptions[0];
      setSelectedQuantity(fallback.value);
    }
  }, [quantityOptions, selectedQuantity, setSelectedQuantity]);

  return {
    dmDtSpark,
    dtSpark,
    eTotalSpark,
    previewQuantityOptions,
    quantityDataStatusById,
    quantityOptions,
    requestedPreviewQuantityDataStatus,
  };
}
