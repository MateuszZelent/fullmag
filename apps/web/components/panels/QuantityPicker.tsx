"use client";

import { useState, useMemo } from "react";
import type { QuantityDescriptor, QuantityId, QuantityShape } from "../../lib/quantities/types";
import {
  uiExposedQuantities,
  interactivePreviewQuantities,
  quantitiesByShape,
} from "../../lib/quantities/catalog";

// ── Props ────────────────────────────────────────────────────────

interface QuantityPickerProps {
  /** Currently selected quantity id. */
  value: QuantityId;
  /** Callback when selection changes. */
  onChange: (id: QuantityId) => void;
  /** Filter: only show quantities matching these shapes. */
  filterShape?: QuantityShape;
  /** Filter: only quantities that support interactive preview. */
  interactiveOnly?: boolean;
  /** Additional class for the wrapper element. */
  className?: string;
}

// ── Component ────────────────────────────────────────────────────

/**
 * Catalog-driven quantity picker.
 *
 * Renders a grouped dropdown/select populated entirely from the
 * canonical quantity catalog.  No hardcoded quantity lists — if a
 * quantity is added to the Rust catalog and propagated to the
 * frontend catalog, it appears here automatically.
 */
export default function QuantityPicker({
  value,
  onChange,
  filterShape,
  interactiveOnly = false,
  className,
}: QuantityPickerProps) {
  const candidates = useMemo(() => {
    let list: QuantityDescriptor[];
    if (interactiveOnly) {
      list = interactivePreviewQuantities();
    } else if (filterShape) {
      list = quantitiesByShape(filterShape);
    } else {
      list = [...uiExposedQuantities()];
    }
    return list;
  }, [filterShape, interactiveOnly]);

  const groups = useMemo(() => {
    const map = new Map<string, QuantityDescriptor[]>();
    for (const q of candidates) {
      const group = groupLabel(q.shape);
      const arr = map.get(group) ?? [];
      arr.push(q);
      map.set(group, arr);
    }
    return map;
  }, [candidates]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as QuantityId)}
      className={className}
    >
      {[...groups.entries()].map(([label, items]) => (
        <optgroup key={label} label={label}>
          {items.map((q) => (
            <option key={q.id} value={q.id}>
              {q.quickAccessLabel ?? q.label}
              {q.unit && q.unit !== "dimensionless" ? ` (${q.unit})` : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function groupLabel(shape: QuantityShape): string {
  switch (shape) {
    case "vector_field":
      return "Vector Fields";
    case "spatial_scalar":
      return "Spatial Scalars";
    case "global_scalar":
      return "Global Scalars";
    default:
      return "Other";
  }
}
