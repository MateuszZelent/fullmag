"use client";

import { useMemo, useState } from "react";

import type {
  DomainMetaResource,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import {
  normalAxisForPlane,
  positionFractionFromCoordinate,
  resolvedAxisCoordinate,
  type DefaultPlanarBounds,
  type DefaultPlanarPlane,
} from "./defaultPlanarSourceModel";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;
type DefaultSlice = PlanarState["default_slice"];
type PlanarPatch = NonNullable<VisualizationStatePatch["planar"]>;

const PLANES = [
  { label: "XY", value: "xy" },
  { label: "XZ", value: "xz" },
  { label: "YZ", value: "yz" },
] as const;

function asBounds(domain: DomainMetaResource | null | undefined): DefaultPlanarBounds | null {
  if (!domain) return null;
  const min = domain.bounds.min;
  const max = domain.bounds.max;
  if (min.length !== 3 || max.length !== 3) return null;
  return {
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
  };
}

export function DefaultPlanarSourceSection({
  defaultSlice,
  domain,
  patch,
  onSaveAsMonitor,
}: {
  defaultSlice: DefaultSlice;
  domain: DomainMetaResource | null | undefined;
  patch: (next: PlanarPatch) => void;
  onSaveAsMonitor?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const bounds = useMemo(() => asBounds(domain), [domain]);
  const plane = defaultSlice.plane as DefaultPlanarPlane;
  const positionFraction = defaultSlice.position_fraction;
  const axis = normalAxisForPlane(plane);
  const coordinate = bounds
    ? resolvedAxisCoordinate(bounds, plane, positionFraction)
    : null;

  const patchSlice = (next: Partial<DefaultSlice>) =>
    patch({ default_slice: { ...defaultSlice, ...next } });

  const updateFraction = (raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      setError("Position must be a finite value between 0% and 100%.");
      return;
    }
    setError(null);
    patchSlice({ position_fraction: value });
  };

  const updateCoordinate = (raw: string) => {
    const value = Number(raw);
    if (!bounds || !Number.isFinite(value)) {
      setError("Coordinate must be a finite SI value.");
      return;
    }
    setError(null);
    patchSlice({
      position_fraction: positionFractionFromCoordinate(bounds, plane, value),
    });
  };

  const updateThickness = (raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Slab thickness must be finite and positive.");
      return;
    }
    setError(null);
    patchSlice({ operator: { kind: "slab_average", thickness_m: value } });
  };

  return (
    <InspectorGroup title="Default slice">
      <FieldRow label="Normal axis" value={axis.toUpperCase()} />
      <div className="fm-inspector-form-field">
        <span className="fm-inspector-form-field__label">Plane</span>
        <SegmentedControl
          aria-label="Plane"
          columns={3}
          options={PLANES}
          value={plane}
          onValueChange={(value) =>
            patchSlice({ plane: value as DefaultSlice["plane"] })
          }
        />
      </div>
      <FormField
        aria-valuetext={`${Math.round(positionFraction * 100)}% along ${axis}`}
        error={error ?? undefined}
        label="Position"
        max="1"
        min="0"
        step="0.01"
        type="range"
        value={positionFraction}
        onChange={(event) => updateFraction(event.currentTarget.value)}
      />
      <FormField
        disabled={bounds === null}
        error={error ?? undefined}
        label={`Coordinate (${axis})`}
        unit="m"
        type="number"
        value={coordinate ?? ""}
        onChange={(event) => updateCoordinate(event.currentTarget.value)}
      />
      <div className="fm-inspector-quick-actions" style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <button
          type="button"
          className="fm-button fm-button--ghost fm-button--sm"
          onClick={() => {
            setError(null);
            patchSlice({ position_fraction: 0.5 });
          }}
        >
          Center of domain
        </button>
        {onSaveAsMonitor ? (
          <button
            type="button"
            className="fm-button fm-button--ghost fm-button--sm"
            onClick={onSaveAsMonitor}
          >
            Save as monitor
          </button>
        ) : null}
      </div>
      <FormField
        label="Sampling"
        type="select"
        value={defaultSlice.operator.kind}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (value === "plane_sample") {
            setError(null);
            patchSlice({ operator: { kind: "plane_sample" } });
          } else if (value === "slab_average") {
            setError(null);
            const defaultThickness = bounds
              ? Math.max(1e-9, (bounds.max[axis === "x" ? 0 : axis === "y" ? 1 : 2] - bounds.min[axis === "x" ? 0 : axis === "y" ? 1 : 2]) * 0.05)
              : 1e-9;
            patchSlice({ operator: { kind: "slab_average", thickness_m: defaultThickness } });
          }
        }}
      >
        <option value="plane_sample">Plane sample</option>
        <option value="slab_average">Slab average</option>
      </FormField>
      {defaultSlice.operator.kind === "slab_average" ? (
        <FormField
          error={error ?? undefined}
          label="Thickness"
          min="0"
          step="any"
          type="number"
          unit="m"
          value={defaultSlice.operator.thickness_m}
          onChange={(event) => updateThickness(event.currentTarget.value)}
        />
      ) : null}
    </InspectorGroup>
  );
}
