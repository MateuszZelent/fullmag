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
import { usePlanarPresentationDraftState } from "./PlanarPresentationDraftOwner";
import { PlanarNumberField } from "./PlanarNumberField";
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
}: {
  defaultSlice: DefaultSlice;
  domain: DomainMetaResource | null | undefined;
  patch: (next: PlanarPatch) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const { pending } = usePlanarPresentationDraftState();
  const bounds = useMemo(() => asBounds(domain), [domain]);
  const plane = defaultSlice.plane as DefaultPlanarPlane;
  const positionFraction = defaultSlice.position_fraction;
  const axis = normalAxisForPlane(plane);
  const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  const minimumCoordinate = bounds?.min[axisIndex];
  const maximumCoordinate = bounds?.max[axisIndex];
  const hasCoordinateBounds =
    minimumCoordinate !== undefined &&
    maximumCoordinate !== undefined &&
    Number.isFinite(minimumCoordinate) &&
    Number.isFinite(maximumCoordinate) &&
    minimumCoordinate <= maximumCoordinate;
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

  return (
    <InspectorGroup title="Default slice">
      <FieldRow label="Normal axis" value={axis.toUpperCase()} />
      <div className="fm-inspector-form-field">
        <span className="fm-inspector-form-field__label">Plane</span>
        <SegmentedControl
          aria-label="Plane"
          columns={3}
          disabled={pending}
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
        disabled={pending}
        max="1"
        min="0"
        step="0.01"
        type="range"
        value={positionFraction}
        onChange={(event) => updateFraction(event.currentTarget.value)}
      />
      <PlanarNumberField
        disabled={!hasCoordinateBounds}
        label={`Coordinate (${axis})`}
        maximum={maximumCoordinate}
        minimum={minimumCoordinate}
        path="default_slice.coordinate"
        unit="m"
        value={coordinate}
        onCommit={(value) => {
          if (!bounds) return;
          setError(null);
          patchSlice({
            position_fraction: positionFractionFromCoordinate(bounds, plane, value),
          });
        }}
      />
      <FormField
        disabled={pending}
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
            patchSlice({ operator: { kind: "slab_average", thickness_m: 1e-9 } });
          }
        }}
      >
        <option value="plane_sample">Plane sample</option>
        <option value="slab_average">Slab average</option>
      </FormField>
      {defaultSlice.operator.kind === "slab_average" ? (
        <PlanarNumberField
          label="Thickness"
          minimum={0}
          minimumExclusive
          path="default_slice.thickness"
          unit="m"
          value={defaultSlice.operator.thickness_m}
          onCommit={(value) => {
            setError(null);
            patchSlice({ operator: { kind: "slab_average", thickness_m: value } });
          }}
        />
      ) : null}
    </InspectorGroup>
  );
}
