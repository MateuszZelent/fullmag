"use client";

import { useMemo, useState } from "react";

import type {
  DomainMetaResource,
  PlanarFieldMetaResource,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import {
  formatSectionLength,
  fractionFromLayerIndex,
  fullThicknessSlabOperator,
  layerIndexFromFraction,
  resolvePlanarSectionGeometry,
  resolvedSectionCoordinate,
  sectionReduction,
  type PlanarSectionPlane,
  type PlanarSectionReduction,
} from "@/kernel/visualization/planarSectionModel";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { positionFractionFromCoordinate } from "./defaultPlanarSourceModel";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;
type DefaultSlice = PlanarState["default_slice"];
type PlanarPatch = NonNullable<VisualizationStatePatch["planar"]>;
type PlanarSection = NonNullable<PlanarFieldMetaResource["section"]>;

const PLANES = [
  { label: "XY", value: "xy" },
  { label: "XZ", value: "xz" },
  { label: "YZ", value: "yz" },
] as const;

const REDUCTIONS = [
  { label: "Single layer", value: "single" },
  { label: "Average", value: "average" },
] as const;

export function DefaultPlanarSourceSection({
  defaultSlice,
  domain,
  patch,
  section = null,
}: {
  defaultSlice: DefaultSlice;
  domain: DomainMetaResource | null | undefined;
  patch: (next: PlanarPatch) => void;
  /** Section resolved by the backend for the current sample (requested vs. resolved). */
  section?: PlanarSection | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const plane = defaultSlice.plane as PlanarSectionPlane;
  const geometry = useMemo(
    () => resolvePlanarSectionGeometry(domain, plane),
    [domain, plane],
  );
  const positionFraction = defaultSlice.position_fraction;
  const reduction = sectionReduction(defaultSlice.operator, geometry);
  const axis = geometry?.normal ?? (plane === "xy" ? "z" : plane === "xz" ? "y" : "x");
  const coordinate = geometry ? resolvedSectionCoordinate(geometry, positionFraction) : null;
  const layerCount = geometry?.layerCount ?? null;
  const layerIndex = layerCount !== null
    ? layerIndexFromFraction(positionFraction, layerCount)
    : null;

  const patchSlice = (next: Partial<DefaultSlice>) =>
    patch({ default_slice: { ...defaultSlice, ...next } });

  const setReduction = (next: PlanarSectionReduction) => {
    setError(null);
    if (next === "average") {
      if (geometry) patchSlice({ operator: fullThicknessSlabOperator(geometry) });
      return;
    }
    patchSlice({ operator: { kind: "plane_sample" } });
  };

  const updateFraction = (raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      setError("Position must be a finite value between 0% and 100%.");
      return;
    }
    setError(null);
    patchSlice({ position_fraction: value });
  };

  const updateLayer = (raw: string) => {
    const value = Number(raw);
    if (layerCount === null || !Number.isInteger(value) || value < 0 || value >= layerCount) {
      setError(`Layer must be an integer between 0 and ${(layerCount ?? 1) - 1}.`);
      return;
    }
    setError(null);
    patchSlice({ position_fraction: fractionFromLayerIndex(value, layerCount) });
  };

  const updateCoordinate = (raw: string) => {
    const value = Number(raw);
    if (!domain || !Number.isFinite(value)) {
      setError("Coordinate must be a finite SI value.");
      return;
    }
    setError(null);
    patchSlice({
      position_fraction: positionFractionFromCoordinate(
        {
          min: [domain.bounds.min[0], domain.bounds.min[1], domain.bounds.min[2]],
          max: [domain.bounds.max[0], domain.bounds.max[1], domain.bounds.max[2]],
        },
        plane,
        value,
      ),
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
      <div className="fm-inspector-form-field">
        <span className="fm-inspector-form-field__label">Plane</span>
        <SegmentedControl
          aria-label="Plane"
          columns={3}
          options={PLANES}
          value={plane}
          onValueChange={(value) => {
            setError(null);
            // A full-thickness slab depends on the normal extent, so it is
            // recomputed for the new plane instead of carried over.
            const nextGeometry = resolvePlanarSectionGeometry(domain, value);
            patchSlice({
              plane: value,
              ...(reduction === "average" && nextGeometry
                ? { operator: fullThicknessSlabOperator(nextGeometry) }
                : {}),
            });
          }}
        />
      </div>
      <div className="fm-inspector-form-field">
        <span className="fm-inspector-form-field__label">Reduction</span>
        <SegmentedControl
          aria-label="Reduction"
          columns={2}
          options={REDUCTIONS.map((option) => ({
            ...option,
            disabled: option.value === "average" && geometry === null,
          }))}
          value={reduction}
          onValueChange={setReduction}
        />
      </div>
      {section && reduction !== "average" ? (
        <FieldRow
          label="Requested → resolved"
          value={`${section.normal_axis} ${formatSectionLength(section.requested_coordinate_m)} → ${formatSectionLength(section.resolved_coordinate_m)}${
            section.layer_index != null && section.layer_count != null
              ? ` (cell layer ${section.layer_index} / ${section.layer_count - 1})`
              : " (continuous)"
          }`}
        />
      ) : null}
      {reduction === "average" ? (
        <FieldRow
          label="Section"
          value={`Mean over the full ${axis.toUpperCase()} thickness${
            layerCount !== null ? ` (${layerCount} layers)` : ""
          }`}
        />
      ) : (
        <>
          {layerCount !== null && layerIndex !== null ? (
            <FormField
              aria-valuetext={`Layer ${layerIndex} of ${layerCount}`}
              error={error ?? undefined}
              hint={`${axis} = ${formatSectionLength(coordinate ?? Number.NaN)} · layer ${layerIndex} / ${layerCount - 1}`}
              label="Layer"
              max={String(layerCount - 1)}
              min="0"
              step="1"
              type="range"
              value={layerIndex}
              onChange={(event) => updateLayer(event.currentTarget.value)}
            />
          ) : (
            <>
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
                disabled={!domain}
                error={error ?? undefined}
                label={`Coordinate (${axis})`}
                unit="m"
                type="number"
                value={coordinate ?? ""}
                onChange={(event) => updateCoordinate(event.currentTarget.value)}
              />
            </>
          )}
          <FormField
            label="Sampling"
            type="select"
            value={defaultSlice.operator.kind}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setError(null);
              if (value === "plane_sample") {
                patchSlice({ operator: { kind: "plane_sample" } });
              } else if (value === "slab_average") {
                patchSlice({
                  operator: {
                    kind: "slab_average",
                    thickness_m: geometry?.layerSpacing ?? 1e-9,
                  },
                });
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
        </>
      )}
    </InspectorGroup>
  );
}
