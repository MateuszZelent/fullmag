"use client";

import { useState } from "react";

import type {
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import {
  formatSectionLength,
  fractionFromLayerIndex,
  fullThicknessSlabOperator,
  layerIndexFromFraction,
  matchObjectLayer,
  objectLayerSlice,
  resolvedSectionCoordinate,
  sectionReduction,
  type ObjectSectionLayer,
  type PlanarSectionGeometry,
  type PlanarSectionPlane,
  type PlanarSectionReduction,
} from "@/kernel/visualization/planarSectionModel";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";

type PlanarState = NonNullable<VisualizationStateResource["planar"]>;
type DefaultSlice = PlanarState["default_slice"];
type PlanarPatch = NonNullable<VisualizationStatePatch["planar"]>;

const PLANES = [
  { label: "XY", value: "xy" },
  { label: "XZ", value: "xz" },
  { label: "YZ", value: "yz" },
] as const;

const REDUCTIONS = [
  { label: "Single layer", value: "single" },
  { label: "Average", value: "average" },
] as const;

const FREE_SECTION = "__free_section__";
const NO_OBJECT_LAYERS: readonly ObjectSectionLayer[] = [];

export function DefaultPlanarSourceSection({
  defaultSlice,
  geometry,
  objectLayers = NO_OBJECT_LAYERS,
  patch,
}: {
  defaultSlice: DefaultSlice;
  /** Current base sample's authoritative section geometry; null while unavailable. */
  geometry: PlanarSectionGeometry | null;
  /** Realized objects along the current normal; each is a named slab section. */
  objectLayers?: readonly ObjectSectionLayer[];
  patch: (next: PlanarPatch) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const plane = defaultSlice.plane as PlanarSectionPlane;
  const currentGeometry = geometry?.plane === plane ? geometry : null;
  const positionFraction = defaultSlice.position_fraction;
  const reduction = sectionReduction(defaultSlice.operator, currentGeometry);
  const axis = currentGeometry?.normal ?? (plane === "xy" ? "z" : plane === "xz" ? "y" : "x");
  const coordinate = currentGeometry ? resolvedSectionCoordinate(currentGeometry, positionFraction) : null;
  const requestedCoordinate = currentGeometry
    ? currentGeometry.normalMin + positionFraction * currentGeometry.normalExtent
    : null;
  const layerCount = currentGeometry?.layerCount ?? null;
  const objectLayer = matchObjectLayer(defaultSlice, currentGeometry, objectLayers);
  const layerIndex = layerCount !== null
    ? layerIndexFromFraction(positionFraction, layerCount)
    : null;

  const patchSlice = (next: Partial<DefaultSlice>) =>
    patch({ default_slice: { ...defaultSlice, ...next } });

  const setReduction = (next: PlanarSectionReduction) => {
    setError(null);
    if (next === "average") {
      if (currentGeometry) patchSlice({ operator: fullThicknessSlabOperator(currentGeometry) });
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
    if (!currentGeometry || !Number.isFinite(value)) {
      setError("Coordinate must be a finite SI value.");
      return;
    }
    setError(null);
    patchSlice({
      position_fraction: Math.min(
        1,
        Math.max(0, (value - currentGeometry.normalMin) / currentGeometry.normalExtent),
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
            patchSlice({
              plane: value,
              // The next plane's base metadata is not available yet. Do not
              // preserve a slab thickness calculated for another normal.
              ...(reduction === "average"
                ? { operator: { kind: "plane_sample" as const } }
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
            disabled: option.value === "average" && currentGeometry === null,
          }))}
          value={reduction}
          onValueChange={setReduction}
        />
      </div>
      {currentGeometry && objectLayers.length > 0 ? (
        <FormField
          label="Section"
          type="select"
          value={objectLayer?.objectId ?? FREE_SECTION}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setError(null);
            const layer = objectLayers.find((item) => item.objectId === value);
            patchSlice(layer ? objectLayerSlice(currentGeometry, layer) : { operator: { kind: "plane_sample" } });
          }}
        >
          <option value={FREE_SECTION}>Free section</option>
          {objectLayers.map((layer) => (
            <option key={layer.objectId} value={layer.objectId}>{layer.name}</option>
          ))}
        </FormField>
      ) : null}
      {requestedCoordinate !== null && coordinate !== null && reduction !== "average" ? (
        <FieldRow
          label="Requested → resolved"
          value={`${axis} ${formatSectionLength(requestedCoordinate)} → ${formatSectionLength(coordinate)}${
            layerIndex !== null && layerCount !== null
              ? ` (cell layer ${layerIndex} / ${layerCount - 1})`
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
                disabled={!currentGeometry}
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
                if (currentGeometry) {
                  patchSlice({ operator: fullThicknessSlabOperator(currentGeometry) });
                }
              }
            }}
          >
            <option value="plane_sample">Plane sample</option>
            <option disabled={!currentGeometry} value="slab_average">Slab average</option>
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
