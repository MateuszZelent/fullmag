"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, Crop, X } from "lucide-react";

import type {
  PlanarFieldMetaResource,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import {
  formatSectionLength,
  matchObjectLayer,
  resolvePlanarSectionGeometryFromMeta,
  resolvedSectionCoordinate,
  sectionLayerCount,
  sectionLayerFraction,
  sectionLayerIndex,
  sectionReduction,
  sectionStopPosition,
  type ObjectSectionLayer,
  type PlanarSectionPlane,
} from "@/kernel/visualization/planarSectionModel";
import {
  usePlanarCursorUv,
  type PlanarCursorUv,
  type PlanarUvRect,
} from "@/kernel/visualization/planarToolStore";
import { Button } from "@/shared/ui/Button";
import { Separator } from "@/shared/ui/Separator";
import { Slider } from "@/shared/ui/Slider";

type PlanarSectionResource = NonNullable<PlanarFieldMetaResource["section"]>;
type DefaultOperator = NonNullable<VisualizationStateResource["planar"]>["default_slice"]["operator"];

/** Steps of the continuous position slider (unstructured sections). */
const FRACTION_STEPS = 1000;

export interface PlanarStatusBarProps {
  /** Plane of the Default source; null for a monitor source (no slider). */
  planeLabel: "XY" | "XZ" | "YZ" | null;
  section: PlanarSectionResource | null;
  positionFraction: number;
  /** Called once when a slider drag or key press is released. */
  onPositionCommit(fraction: number): void;
  onStep(direction: -1 | 1): void;
  zoom: number;
  crop: PlanarUvRect | null;
  onClearCrop(): void;
  /** Default-slice operator; an average shows its extent instead of a slider. */
  operator?: DefaultOperator;
  /** Realized objects along the normal; a matching slab is named in the caption. */
  objectLayers?: readonly ObjectSectionLayer[];
  /** Normal coordinate of the frame on screen (may lag a new request). */
  shownCoordinateM?: number | null;
  /** Formats the cursor position in the plane's world axes. */
  formatCursor?: (cursor: PlanarCursorUv) => string;
  /** Formats the crop window in the plane's world axes. */
  formatCrop?: (crop: PlanarUvRect) => string;
}

function defaultCursorLabel(cursor: PlanarCursorUv): string {
  return `u ${formatSectionLength(cursor.u_m)} · v ${formatSectionLength(cursor.v_m)}`;
}

function cropLabel(crop: PlanarUvRect): string {
  return `u ${formatSectionLength(crop.u_min_m)}…${formatSectionLength(crop.u_max_m)} · v ${formatSectionLength(crop.v_min_m)}…${formatSectionLength(crop.v_max_m)}`;
}

/**
 * Thin bar under the 2D canvas (plan §2.1 D): plane, section position slider
 * with ‹ › steps, the normal coordinate, cut elements, cursor position, zoom
 * and the crop chip. The slider keeps a local draft while dragging and
 * commits once on release, so a drag never floods the visualization state.
 */
export function PlanarStatusBar({
  planeLabel,
  section,
  positionFraction,
  onPositionCommit,
  onStep,
  zoom,
  crop,
  onClearCrop,
  operator = { kind: "plane_sample" },
  objectLayers = [],
  shownCoordinateM = null,
  formatCursor = defaultCursorLabel,
  formatCrop = cropLabel,
}: PlanarStatusBarProps) {
  const cursor = usePlanarCursorUv();
  const plane = planeLabel ? (planeLabel.toLowerCase() as PlanarSectionPlane) : null;
  const geometry = plane ? resolvePlanarSectionGeometryFromMeta(section, plane) : null;
  const reduction = sectionReduction(operator, geometry);
  const objectLayer = plane
    ? matchObjectLayer({ operator, position_fraction: positionFraction }, geometry, objectLayers)
    : null;
  const layerCount = sectionLayerCount(geometry);
  const layerNoun = geometry?.stops ? "node plane" : "layer";
  const [draft, setDraft] = useState<{ key: string; value: number } | null>(null);
  const draftKey = `${plane ?? "monitor"}:${layerCount ?? "continuous"}`;
  const committedStep = layerCount !== null && geometry
    ? sectionLayerIndex(geometry, positionFraction) ?? 0
    : Math.round(positionFraction * FRACTION_STEPS);
  const drafting = draft?.key === draftKey;
  const step = drafting ? draft.value : committedStep;
  const stepFraction = (value: number) => layerCount !== null && geometry
    ? sectionLayerFraction(geometry, value)
    : value / FRACTION_STEPS;
  // A committed FEM request may sit between node planes; the backend samples
  // it there, so the readout names that instead of the nearest plane.
  const betweenStops = !drafting && geometry?.stops
    ? !sectionStopPosition(geometry, positionFraction).onStop
    : false;
  const cutElements = layerCount === null && section?.plane === plane
    ? section?.cut_element_count ?? null
    : null;
  const fraction = drafting ? stepFraction(step) : positionFraction;
  const coordinate = geometry ? resolvedSectionCoordinate(geometry, fraction) : null;
  const axis = geometry?.normal ?? (plane === "xy" ? "z" : plane === "xz" ? "y" : "x");
  // While a retained frame is on screen, say which position it shows and
  // which one is loading instead of implying the new one is displayed.
  const pendingCoordinate = geometry !== null &&
    coordinate !== null &&
    shownCoordinateM !== null &&
    Number.isFinite(shownCoordinateM) &&
    Math.abs(shownCoordinateM - coordinate) > 1e-6 * geometry.normalExtent;

  const commit = (value: number) => {
    setDraft(null);
    if (value === committedStep) return;
    onPositionCommit(stepFraction(value));
  };
  const stepBy = (direction: -1 | 1) => {
    setDraft(null);
    onStep(direction);
  };

  const caption = (() => {
    if (reduction === "average") {
      return `Mean over ${axis.toUpperCase()}${layerCount !== null ? ` · ${layerCount} layers` : ""}`;
    }
    if (objectLayer && !drafting) {
      return `${objectLayer.name} · ${axis} ∈ [${formatSectionLength(objectLayer.min)}, ${formatSectionLength(objectLayer.max)}] · slab`;
    }
    const prefix = pendingCoordinate
      ? `showing ${axis} = ${formatSectionLength(shownCoordinateM ?? Number.NaN)} · loading `
      : `${axis}: `;
    const suffix = layerCount === null
      ? cutElements !== null && !pendingCoordinate
        ? ` · ${cutElements.toLocaleString("en-US")} el.`
        : ""
      : betweenStops
        ? ` · between ${layerNoun}s`
        : ` · ${layerNoun} ${step} / ${layerCount - 1}`;
    return `${prefix}${formatSectionLength(coordinate ?? Number.NaN)}${suffix}`;
  })();

  return (
    <div aria-label="2D view status" className="fm-planar-statusbar" role="group">
      <span className="fm-planar-statusbar__plane">{planeLabel ?? "Monitor"}</span>
      {plane && reduction !== "average" ? (
        <div className="fm-planar-statusbar__section">
          <Button
            aria-keyshortcuts="["
            aria-label={layerCount !== null ? "Previous layer" : "Move section back"}
            disabled={geometry === null}
            size="icon"
            type="button"
            variant="ghost"
            onClick={() => stepBy(-1)}
          >
            <ChevronLeft aria-hidden="true" size={14} />
          </Button>
          <Slider
            aria-label={layerCount !== null ? `Layer along ${axis}` : `Position along ${axis}`}
            className="fm-planar-statusbar__slider"
            disabled={geometry === null || (layerCount !== null && layerCount < 2)}
            max={layerCount !== null ? Math.max(layerCount - 1, 0) : FRACTION_STEPS}
            min={0}
            step={1}
            value={[step]}
            onValueChange={(values) => {
              const value = values[0];
              if (value !== undefined) setDraft({ key: draftKey, value });
            }}
            onValueCommit={(values) => {
              const value = values[0];
              if (value !== undefined) commit(value);
            }}
          />
          <Button
            aria-keyshortcuts="]"
            aria-label={layerCount !== null ? "Next layer" : "Move section forward"}
            disabled={geometry === null}
            size="icon"
            type="button"
            variant="ghost"
            onClick={() => stepBy(1)}
          >
            <ChevronRight aria-hidden="true" size={14} />
          </Button>
        </div>
      ) : null}
      {plane ? (
        <span
          aria-live="polite"
          className="fm-planar-statusbar__caption"
          title={cutElements !== null && geometry?.navigationStepM
            ? `‹ › step ${formatSectionLength(geometry.navigationStepM)}: median height of the cut elements (navigation aid, not a data layer)`
            : undefined}
        >
          {caption}
        </span>
      ) : null}
      <Separator className="fm-planar-statusbar__separator" orientation="vertical" />
      <output aria-label="Cursor position" className="fm-planar-statusbar__cursor">
        {cursor ? formatCursor(cursor) : "—"}
      </output>
      <span aria-label="Zoom" className="fm-planar-statusbar__zoom">
        {`${Math.round(zoom * 100)}%`}
      </span>
      {crop ? (
        <span className="fm-planar-statusbar__crop" data-planar-crop="">
          <Crop aria-hidden="true" size={12} />
          <span>{formatCrop(crop)}</span>
          <Button
            aria-label="Clear crop"
            size="icon"
            type="button"
            variant="ghost"
            onClick={onClearCrop}
          >
            <X aria-hidden="true" size={12} />
          </Button>
        </span>
      ) : null}
    </div>
  );
}
