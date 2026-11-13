"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, ScanLine } from "lucide-react";

import type { VisualizationStatePatch, VisualizationStateResource } from "@/kernel/api/apiTypes";
import {
  formatSectionLength,
  fullThicknessSlabOperator,
  matchObjectLayer,
  objectLayerSlice,
  resolvedSectionCoordinate,
  sectionReduction,
  stepSectionFraction,
  type ObjectSectionLayer,
  type PlanarSectionGeometry,
  type PlanarSectionPlane,
  type PlanarSectionReduction,
} from "@/kernel/visualization/planarSectionModel";
import { Button } from "@/shared/ui/Button";
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
export const MONITOR_DEFINED_REASON = "Defined by the monitor";

/** Fraction of the requested normal position in nm, clamped to the section. */
export function sectionFractionFromNanometres(
  raw: string,
  geometry: PlanarSectionGeometry,
): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || geometry.normalExtent <= 0) return null;
  const fraction = (value * 1e-9 - geometry.normalMin) / geometry.normalExtent;
  return Math.min(1, Math.max(0, fraction));
}

function nanometres(meters: number): string {
  return String(Number((meters * 1e9).toFixed(3)));
}

/**
 * Shared section plane of all 2D layers (plan §2.4 block 4): source, plane,
 * mode, named section and normal position. A monitor source owns its plane.
 */
export function PlanarSectionPlaneSection({
  defaultSlice,
  geometry,
  monitors,
  objectLayers = NO_OBJECT_LAYERS,
  source,
  patch,
}: {
  defaultSlice: DefaultSlice;
  /** Base sample's authoritative section geometry; null while unavailable. */
  geometry: PlanarSectionGeometry | null;
  monitors: readonly { id: string; name: string }[];
  objectLayers?: readonly ObjectSectionLayer[];
  source: PlanarState["source"];
  patch: (next: PlanarPatch) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const monitorSource = source.kind === "monitor";
  const plane = defaultSlice.plane as PlanarSectionPlane;
  const currentGeometry = geometry?.plane === plane ? geometry : null;
  const fraction = defaultSlice.position_fraction;
  const reduction = sectionReduction(defaultSlice.operator, currentGeometry);
  const axis = currentGeometry?.normal ?? (plane === "xy" ? "z" : plane === "xz" ? "y" : "x");
  const requested = currentGeometry ? currentGeometry.normalMin + fraction * currentGeometry.normalExtent : null;
  const resolved = currentGeometry ? resolvedSectionCoordinate(currentGeometry, fraction) : null;
  const objectLayer = matchObjectLayer(defaultSlice, currentGeometry, objectLayers);
  const readOnlyReason = monitorSource ? MONITOR_DEFINED_REASON : undefined;
  const sourceValue = source.kind === "monitor" ? source.monitor_id : "default";

  const patchSlice = (next: Partial<DefaultSlice>, extra: PlanarPatch = {}) =>
    patch({ default_slice: { ...defaultSlice, ...next }, ...extra });

  const commitPosition = (raw: string) => {
    if (!currentGeometry) {
      setError("The section extent is not available yet.");
      return;
    }
    const next = sectionFractionFromNanometres(raw, currentGeometry);
    if (next === null) {
      setError("Position must be a finite value in nm.");
      return;
    }
    setError(null);
    setDraft(null);
    patchSlice({ position_fraction: next });
  };

  const setReduction = (next: PlanarSectionReduction) => {
    setError(null);
    if (next === "average") {
      if (currentGeometry) patchSlice({ operator: fullThicknessSlabOperator(currentGeometry) });
      return;
    }
    patchSlice({ operator: { kind: "plane_sample" } });
  };

  return (
    <InspectorGroup
      icon={<ScanLine aria-hidden="true" size={16} strokeWidth={1.75} />}
      badge={monitorSource
        ? `${monitors.find((monitor) => monitor.id === sourceValue)?.name ?? sourceValue} · Monitor`
        : `Default · ${plane.toUpperCase()}`}
      title="Section plane"
    >
      <div aria-label="Planar section controls" className="grid min-w-0 gap-fm-inspector-control" role="group">
        <FormField
          label="Source"
          type="select"
          value={sourceValue}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setError(null);
            setDraft(null);
            // A crop is expressed in the old frame's u/v axes; clear it with the source.
            patch({
              source: value === "default" ? { kind: "default" } : { kind: "monitor", monitor_id: value },
              crop: null,
            });
          }}
        >
          <option value="default">Default</option>
          <optgroup label="Monitors">
            {monitors.map((monitor) => <option key={monitor.id} value={monitor.id}>{monitor.name}</option>)}
          </optgroup>
        </FormField>
        <div className="fm-inspector-form-field">
          <span className="fm-inspector-form-field__label">Plane</span>
          <SegmentedControl
            aria-label="Plane"
            columns={3}
            options={PLANES.map((option) => ({ ...option, disabled: monitorSource }))}
            value={plane}
            onValueChange={(value) => {
              setError(null);
              setDraft(null);
              patchSlice({
                plane: value,
                // A slab thickness belongs to the previous normal.
                ...(reduction === "average" ? { operator: { kind: "plane_sample" as const } } : {}),
              }, { crop: null });
            }}
          />
        </div>
        <div className="fm-inspector-form-field">
          <span className="fm-inspector-form-field__label">Mode</span>
          <SegmentedControl
            aria-label="Mode"
            columns={2}
            options={REDUCTIONS.map((option) => ({
              ...option,
              disabled: monitorSource || (option.value === "average" && currentGeometry === null),
            }))}
            value={reduction}
            onValueChange={setReduction}
          />
        </div>
        {!monitorSource && currentGeometry && objectLayers.length > 0 ? (
          <FormField
            label="Section"
            type="select"
            value={objectLayer?.objectId ?? FREE_SECTION}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setError(null);
              setDraft(null);
              const layer = objectLayers.find((item) => item.objectId === value);
              patchSlice(layer ? objectLayerSlice(currentGeometry, layer) : { operator: { kind: "plane_sample" } });
            }}
          >
            <option value={FREE_SECTION}>Free section</option>
            {objectLayers.map((layer) => <option key={layer.objectId} value={layer.objectId}>{layer.name}</option>)}
          </FormField>
        ) : null}
        {reduction === "average" && !monitorSource ? (
          <FieldRow label="Position" value={`Mean over the full ${axis.toUpperCase()} thickness`} />
        ) : (
          <div className="fm-planar-section-position">
            <FormField
              disabled={monitorSource || !currentGeometry}
              error={error ?? undefined}
              hint={readOnlyReason ?? (!currentGeometry ? "Waiting for the section extent." : undefined)}
              label={`Position (${axis})`}
              type="number"
              unit="nm"
              value={draft ?? (requested !== null ? nanometres(requested) : "")}
              onBlur={(event) => { if (draft !== null) commitPosition(event.currentTarget.value); }}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitPosition(event.currentTarget.value);
                } else if (event.key === "Escape") {
                  setDraft(null);
                  setError(null);
                }
              }}
            />
            <div className="fm-planar-section-position__steps">
              <Button
                aria-label="Previous section"
                disabled={monitorSource || !currentGeometry}
                size="icon"
                type="button"
                variant="ghost"
                onClick={() => { setDraft(null); setError(null); patchSlice({ position_fraction: stepSectionFraction(fraction, currentGeometry, -1) }); }}
              >
                <ChevronLeft aria-hidden="true" size={14} />
              </Button>
              <Button
                aria-label="Next section"
                disabled={monitorSource || !currentGeometry}
                size="icon"
                type="button"
                variant="ghost"
                onClick={() => { setDraft(null); setError(null); patchSlice({ position_fraction: stepSectionFraction(fraction, currentGeometry, 1) }); }}
              >
                <ChevronRight aria-hidden="true" size={14} />
              </Button>
            </div>
          </div>
        )}
        {monitorSource ? <FieldRow label="Plane, mode and position" value={MONITOR_DEFINED_REASON} /> : null}
        {!monitorSource && requested !== null && resolved !== null && reduction !== "average" ? (
          <FieldRow
            label="Requested → resolved"
            value={`${axis} ${formatSectionLength(requested)} → ${formatSectionLength(resolved)}`}
          />
        ) : null}
      </div>
    </InspectorGroup>
  );
}
