"use client";

import { useState, type ReactNode } from "react";
import { Crop, Maximize } from "lucide-react";

import type { PlanarCropState } from "@/kernel/api/apiTypes";
import { Button } from "@/shared/ui/Button";

import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";

type CropField = keyof PlanarCropState;
type FullBounds = readonly [number, number, number, number];

const FIELDS: readonly { field: CropField; axis: "u" | "v"; bound: "min" | "max"; boundsIndex: number }[] = [
  { field: "u_min_m", axis: "u", bound: "min", boundsIndex: 0 },
  { field: "u_max_m", axis: "u", bound: "max", boundsIndex: 1 },
  { field: "v_min_m", axis: "v", bound: "min", boundsIndex: 2 },
  { field: "v_max_m", axis: "v", bound: "max", boundsIndex: 3 },
];

function nanometres(meters: number): string {
  return String(Number((meters * 1e9).toFixed(3)));
}

/** Validates one edited crop limit against the other three; errors name the edited field. */
export function planarCropFromEdit(
  base: PlanarCropState,
  field: CropField,
  raw: string,
): { crop: PlanarCropState } | { error: string } {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) return { error: "Enter a finite value in nm." };
  const crop = { ...base, [field]: value * 1e-9 };
  if (crop.u_min_m >= crop.u_max_m) {
    return { error: field.endsWith("min_m") ? "Minimum must be below the maximum." : "Maximum must be above the minimum." };
  }
  if (crop.v_min_m >= crop.v_max_m) {
    return { error: field.endsWith("min_m") ? "Minimum must be below the maximum." : "Maximum must be above the minimum." };
  }
  return { crop };
}

/**
 * Crop window and view of the 2D section (plan §2.4 block 5). The crop
 * resamples the backend window; zoom and Fit only change the view.
 */
export function PlanarCropViewSection({
  axisLabels,
  crop,
  fullBounds,
  quality,
  zoom,
  onClear,
  onCrop,
  onFit,
}: {
  axisLabels: { u: string; v: string };
  crop: PlanarCropState | null;
  /** Full u/v bounds of the uncropped frame; null when no sample is available. */
  fullBounds: FullBounds | null;
  quality?: ReactNode;
  zoom: number;
  onClear: () => void;
  onCrop: (crop: PlanarCropState) => void;
  onFit: () => void;
}) {
  const [drafts, setDrafts] = useState<Partial<Record<CropField, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<CropField, string>>>({});
  const base: PlanarCropState | null = crop ?? (fullBounds
    ? { u_min_m: fullBounds[0], u_max_m: fullBounds[1], v_min_m: fullBounds[2], v_max_m: fullBounds[3] }
    : null);

  const commit = (field: CropField, raw: string) => {
    if (!base) {
      setErrors({ [field]: "The section frame is not available yet." });
      return;
    }
    const result = planarCropFromEdit(base, field, raw);
    if ("error" in result) {
      setErrors({ [field]: result.error });
      return;
    }
    setErrors({});
    setDrafts({});
    onCrop(result.crop);
  };

  return (
    <InspectorGroup
      icon={<Crop aria-hidden="true" size={16} strokeWidth={1.75} />}
      badge={crop ? "Cropped" : "Full frame"}
      title="Crop and view"
    >
      <div className="fm-planar-crop-grid">
        {FIELDS.map(({ field, axis, bound, boundsIndex }) => (
          <FormField
            key={field}
            error={errors[field]}
            label={`${axisLabels[axis]} ${bound}`}
            placeholder={fullBounds ? nanometres(fullBounds[boundsIndex]!) : "—"}
            type="number"
            unit="nm"
            value={drafts[field] ?? (crop ? nanometres(crop[field]) : "")}
            onBlur={(event) => { if (drafts[field] !== undefined) commit(field, event.currentTarget.value); }}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDrafts((current) => ({ ...current, [field]: value }));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit(field, event.currentTarget.value);
              } else if (event.key === "Escape") {
                setDrafts((current) => ({ ...current, [field]: undefined }));
                setErrors({});
              }
            }}
          />
        ))}
      </div>
      <div className="fm-inspector-toolbar">
        <Button
          disabled={!crop}
          disabledReason="No crop is set."
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            setDrafts({});
            setErrors({});
            onClear();
          }}
        >
          Clear crop
        </Button>
        <Button size="sm" type="button" variant="secondary" onClick={onFit}>
          <Maximize aria-hidden="true" size={14} /> Fit
        </Button>
      </div>
      <FieldRow label="Zoom" value={`${Math.round(zoom * 100)}%`} />
      {quality}
    </InspectorGroup>
  );
}
