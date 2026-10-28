"use client";

import { useState } from "react";

import type {
  DomainMetaResource,
  PlanarFieldMetaResource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import {
  formatSectionLength,
  fullThicknessSlabOperator,
  matchObjectLayer,
  objectLayerSlice,
  resolvePlanarSectionGeometry,
  resolvedSectionCoordinate,
  sectionLayerCount,
  sectionLayerFraction,
  sectionLayerIndex,
  sectionReduction,
  sectionStopPosition,
  stepSectionFraction,
  withSectionStops,
  type ObjectSectionLayer,
  type PlanarSectionPlane,
  type PlanarSectionReduction,
} from "@/kernel/visualization/planarSectionModel";
import { Button } from "@/shared/ui/Button";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

type DefaultSlice = NonNullable<VisualizationStateResource["planar"]>["default_slice"];

const PLANES = [
  { label: "XY", value: "xy", accessibleLabel: "XY plane, cut along Z" },
  { label: "XZ", value: "xz", accessibleLabel: "XZ plane, cut along Y" },
  { label: "YZ", value: "yz", accessibleLabel: "YZ plane, cut along X" },
] as const;

const FRACTION_STEPS = 1000;
const FREE_SECTION = "__free_section__";

/**
 * Section controls above the planar surface (MuMax3-style): plane, single
 * layer vs. full-thickness average, and the layer/position along the normal.
 * They edit the same session `default_slice` as the Inspector.
 */
export function PlanarSectionStrip({
  defaultSlice,
  domain,
  objectLayers = [],
  section = null,
  shownCoordinate = null,
  onChange,
}: {
  defaultSlice: DefaultSlice;
  domain: DomainMetaResource | null | undefined;
  /** Realized objects along the current normal; each is a named slab layer. */
  objectLayers?: readonly ObjectSectionLayer[];
  /** Backend section of the current sample; supplies FEM node-plane stops. */
  section?: PlanarFieldMetaResource["section"] | null;
  /** Normal coordinate of the frame currently on screen (may lag a new request). */
  shownCoordinate?: number | null;
  onChange: (next: DefaultSlice) => void;
}) {
  const plane = defaultSlice.plane as PlanarSectionPlane;
  const geometry = withSectionStops(resolvePlanarSectionGeometry(domain, plane), section);
  const reduction = sectionReduction(defaultSlice.operator, geometry);
  const objectLayer = matchObjectLayer(defaultSlice, geometry, objectLayers);
  const layerCount = sectionLayerCount(geometry);
  const layerNoun = geometry?.stops ? "node plane" : "layer";
  const [draft, setDraft] = useState<{ key: string; value: number } | null>(null);
  const draftKey = `${plane}:${layerCount ?? "continuous"}`;
  const committedStep = layerCount !== null && geometry
    ? sectionLayerIndex(geometry, defaultSlice.position_fraction) ?? 0
    : Math.round(defaultSlice.position_fraction * FRACTION_STEPS);
  const drafting = draft?.key === draftKey;
  const step = drafting ? draft.value : committedStep;
  // A committed FEM request may sit between node planes; the backend samples
  // it there, so the readout names that instead of the nearest plane.
  const betweenStops = !drafting && geometry?.stops
    ? !sectionStopPosition(geometry, defaultSlice.position_fraction).onStop
    : false;
  // Outside a drag the readout follows the committed request exactly; the
  // model applies the FDM and node-plane snaps the backend uses.
  const cutElements = layerCount === null && section?.plane === plane
    ? section.cut_element_count ?? null
    : null;
  const fraction = !drafting
    ? defaultSlice.position_fraction
    : layerCount !== null && geometry
      ? sectionLayerFraction(geometry, step)
      : step / FRACTION_STEPS;
  const coordinate = geometry ? resolvedSectionCoordinate(geometry, fraction) : null;
  const axis = geometry?.normal ?? (plane === "xy" ? "z" : plane === "xz" ? "y" : "x");

  const change = (next: Partial<DefaultSlice>) => onChange({ ...defaultSlice, ...next });
  // Dragging updates a local draft; releasing the control patches the state once.
  const commitDraft = () => {
    if (draft?.key !== draftKey) return;
    setDraft(null);
    if (draft.value === committedStep) return;
    change({
      position_fraction: layerCount !== null && geometry
        ? sectionLayerFraction(geometry, draft.value)
        : draft.value / FRACTION_STEPS,
    });
  };
  const stepLayer = (delta: number) => {
    setDraft(null);
    const next = stepSectionFraction(defaultSlice.position_fraction, geometry, delta);
    if (next !== defaultSlice.position_fraction) change({ position_fraction: next });
  };
  // Decision 8: while a retained frame is on screen, say which layer it shows
  // and which one is loading instead of implying the new layer is displayed.
  const pendingCoordinate = geometry !== null &&
    coordinate !== null &&
    shownCoordinate !== null &&
    Number.isFinite(shownCoordinate) &&
    Math.abs(shownCoordinate - coordinate) > 1e-6 * geometry.normalExtent;
  const setReduction = (next: PlanarSectionReduction) => {
    if (next === "average") {
      if (geometry) change({ operator: fullThicknessSlabOperator(geometry) });
      return;
    }
    change({ operator: { kind: "plane_sample" } });
  };

  return (
    <div aria-label="Section" className="fm-field-map__section" role="group">
      <SegmentedControl
        aria-label="Section plane"
        columns={3}
        options={PLANES}
        value={plane}
        onValueChange={(value) => {
          setDraft(null);
          const nextGeometry = resolvePlanarSectionGeometry(domain, value);
          change({
            plane: value,
            ...(reduction === "average" && nextGeometry
              ? { operator: fullThicknessSlabOperator(nextGeometry) }
              : {}),
          });
        }}
      />
      <SegmentedControl
        aria-label="Section reduction"
        columns={2}
        options={[
          { label: "Single layer", value: "single" },
          { label: "Average", value: "average", disabled: geometry === null },
        ]}
        value={reduction}
        onValueChange={setReduction}
      />
      {geometry && objectLayers.length > 0 ? (
        <Select
          value={objectLayer?.objectId ?? FREE_SECTION}
          onValueChange={(value) => {
            setDraft(null);
            const layer = objectLayers.find((item) => item.objectId === value);
            change(layer ? objectLayerSlice(geometry, layer) : { operator: { kind: "plane_sample" } });
          }}
        >
          <SelectTrigger aria-label="Object layer" className="fm-field-map__object-layer" density="compact">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={FREE_SECTION}>Free section</SelectItem>
            {objectLayers.map((layer) => (
              <SelectItem key={layer.objectId} value={layer.objectId}>{layer.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {reduction === "average" ? (
        <span className="fm-field-map__section-caption">
          Mean over {axis.toUpperCase()}
          {layerCount !== null ? ` · ${layerCount} layers` : ""}
        </span>
      ) : (
        <>
          <Button
            aria-keyshortcuts="["
            aria-label={layerCount !== null ? "Previous layer" : "Move section back"}
            disabled={geometry === null}
            size="icon"
            type="button"
            variant="ghost"
            onClick={() => stepLayer(-1)}
          >
            ‹
          </Button>
          <input
            aria-label={layerCount !== null ? `Layer along ${axis}` : `Position along ${axis}`}
            aria-valuetext={`${axis} = ${formatSectionLength(coordinate ?? Number.NaN)}${
              layerCount !== null ? `, ${layerNoun} ${step} of ${layerCount}` : ""
            }`}
            className="fm-field-map__section-slider"
            disabled={geometry === null || (layerCount !== null && layerCount < 2)}
            max={layerCount !== null ? Math.max(layerCount - 1, 0) : FRACTION_STEPS}
            min={0}
            step={1}
            type="range"
            value={step}
            onBlur={commitDraft}
            onChange={(event) =>
              setDraft({ key: draftKey, value: Number(event.currentTarget.value) })
            }
            onKeyUp={commitDraft}
            onPointerUp={commitDraft}
          />
          <Button
            aria-keyshortcuts="]"
            aria-label={layerCount !== null ? "Next layer" : "Move section forward"}
            disabled={geometry === null}
            size="icon"
            type="button"
            variant="ghost"
            onClick={() => stepLayer(1)}
          >
            ›
          </Button>
          <span
            aria-live="polite"
            className="fm-field-map__section-caption"
            title={cutElements !== null && geometry?.navigationStepM
              ? `‹ › step ${formatSectionLength(geometry.navigationStepM)}: median height of the cut elements (navigation aid, not a data layer)`
              : undefined}
          >
            {objectLayer && !drafting ? (
              `${objectLayer.name} · ${axis} ∈ [${formatSectionLength(objectLayer.min)}, ${formatSectionLength(objectLayer.max)}] · slab`
            ) : (
              <>
            {pendingCoordinate
              ? `showing ${axis} = ${formatSectionLength(shownCoordinate)} · loading `
              : `${axis}: `}
            {formatSectionLength(coordinate ?? Number.NaN)}
            {layerCount === null
              ? cutElements !== null && !pendingCoordinate
                ? ` · ${cutElements.toLocaleString("en-US")} elements cut`
                : ""
              : betweenStops
                ? ` · between ${layerNoun}s`
                : ` · ${layerNoun} ${step} / ${layerCount - 1}`}
              </>
            )}
          </span>
        </>
      )}
    </div>
  );
}
