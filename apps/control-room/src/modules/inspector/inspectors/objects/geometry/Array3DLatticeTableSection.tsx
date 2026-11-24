"use client";

import { ChevronDown, ChevronRight, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  applyArray3DPreset,
  axisSpanM,
  computeArray3DBudgetStatus,
  computeArray3DInstanceCount,
  computeArray3DWorldBounds,
  MAX_ARRAY_AXIS_COUNT,
  MAX_EXPANDED_SCENE_OBJECTS,
  parseArray3DGeometry,
  type Array3DAxes,
  type Array3DPresetId,
  type ArrayAxisSpec,
  type ArrayDirection,
  type ArrayRealizationMode,
  type Vec3Tuple,
} from "@/kernel/authoring/array3dModel";
import { computeSceneGeometryBoundsMeters } from "@/shared/domain/geometry/sceneGeometryBounds";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { Switch } from "@/shared/ui/Switch";

import type { Array3DDraftConfig } from "./geometryShared";

export type DisplayLengthUnit = "nm" | "um" | "mm";

const UNIT_SCALE_M: Record<DisplayLengthUnit, number> = {
  mm: 1e-3,
  nm: 1e-9,
  um: 1e-6,
};

const UNIT_LABELS: Record<DisplayLengthUnit, string> = {
  mm: "mm",
  nm: "nm",
  um: "\u00b5m",
};

const UNIT_OPTIONS: readonly { label: string; value: DisplayLengthUnit }[] = [
  { label: "nm", value: "nm" },
  { label: "\u00b5m", value: "um" },
  { label: "mm", value: "mm" },
];

const PRESET_ITEMS: readonly { id: Array3DPresetId; label: string }[] = [
  { id: "rectangular_xy", label: "Rectangular XY" },
  { id: "hexagonal_xy", label: "Hexagonal XY" },
  { id: "multilayer_z", label: "Multilayer Z" },
  { id: "stripe_1d", label: "1D Stripe" },
];

const DIRECTION_OPTIONS: readonly {
  accessibleLabel: string;
  label: string;
  value: ArrayDirection;
}[] = [
  { accessibleLabel: "Positive direction", label: "+", value: "positive" },
  { accessibleLabel: "Negative direction", label: "\u2212", value: "negative" },
  { accessibleLabel: "Symmetric direction", label: "\u00b1", value: "symmetric" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function resolveArray3DChildBoundsMeters(
  sceneObj: unknown,
  targetGeometry: unknown,
): { max: Vec3Tuple; min: Vec3Tuple; size: Vec3Tuple } {
  const existingArray = parseArray3DGeometry(targetGeometry);
  const childGeom = existingArray ? existingArray.child : targetGeometry;
  const childTx = existingArray?.childTransform;
  const computed = computeSceneGeometryBoundsMeters(childGeom, childTx);
  if (computed) {
    return {
      max: [...computed.max],
      min: [...computed.min],
      size: [...computed.size],
    };
  }

  const objRec = asRecord(sceneObj);
  const geomRec = asRecord(targetGeometry) ?? asRecord(objRec?.geometry);
  const rec = asRecord(objRec?.bounds) ?? geomRec;
  const rawMin = Array.isArray(rec?.min)
    ? rec.min
    : Array.isArray(rec?.bounds_min)
      ? rec.bounds_min
      : null;
  const rawMax = Array.isArray(rec?.max)
    ? rec.max
    : Array.isArray(rec?.bounds_max)
      ? rec.bounds_max
      : null;
  if (
    rawMin &&
    rawMax &&
    rawMin.length >= 3 &&
    rawMax.length >= 3 &&
    rawMin.every((v) => typeof v === "number" && Number.isFinite(v)) &&
    rawMax.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    const min: Vec3Tuple = [rawMin[0] as number, rawMin[1] as number, rawMin[2] as number];
    const max: Vec3Tuple = [rawMax[0] as number, rawMax[1] as number, rawMax[2] as number];
    return { max, min, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
  }
  const paramsRec = asRecord(geomRec?.geometry_params);
  const rawSize = Array.isArray(rec?.size)
    ? rec.size
    : Array.isArray(paramsRec?.size)
      ? paramsRec.size
      : null;
  const sx = typeof rawSize?.[0] === "number" && Number.isFinite(rawSize[0]) ? rawSize[0] : 100e-9;
  const sy = typeof rawSize?.[1] === "number" && Number.isFinite(rawSize[1]) ? rawSize[1] : 100e-9;
  const sz = typeof rawSize?.[2] === "number" && Number.isFinite(rawSize[2]) ? rawSize[2] : 10e-9;
  return {
    max: [sx / 2, sy / 2, sz / 2],
    min: [-sx / 2, -sy / 2, -sz / 2],
    size: [sx, sy, sz],
  };
}

function formatInUnit(meters: number, unit: DisplayLengthUnit): string {
  const scaled = meters / UNIT_SCALE_M[unit];
  if (!Number.isFinite(scaled)) return "0";
  return Number(scaled.toFixed(3)).toString();
}

function parseDisplayNumber(raw: string, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface Array3DLatticeTableSectionProps {
  value: Array3DDraftConfig;
  onChange: (next: Array3DDraftConfig) => void;
  childBounds: { max: Vec3Tuple; min: Vec3Tuple; size: Vec3Tuple };
  unit?: DisplayLengthUnit;
  onUnitChange?: (unit: DisplayLengthUnit) => void;
  disableExpandToObjects?: boolean;
  disabled?: boolean;
  onRemoveModifier?: () => void;
}

/**
 * Controlled Array 3D lattice editor. All edits stage into the enclosing
 * inspector draft and commit exclusively through the single footer CommitBar.
 */
export function Array3DLatticeTableSection({
  value,
  onChange,
  childBounds,
  unit: controlledUnit,
  onUnitChange,
  disableExpandToObjects = false,
  disabled = false,
  onRemoveModifier,
}: Array3DLatticeTableSectionProps) {
  const [fallbackUnit, setFallbackUnit] = useState<DisplayLengthUnit>("nm");
  const [showAdvancedTable, setShowAdvancedTable] = useState(false);

  const unit = controlledUnit ?? fallbackUnit;
  const handleUnitChange = useCallback(
    (nextUnit: DisplayLengthUnit) => {
      if (onUnitChange) {
        onUnitChange(nextUnit);
      } else {
        setFallbackUnit(nextUnit);
      }
    },
    [onUnitChange],
  );

  const { axes, mergeOverlapping, realization } = value;

  const totalInstances = useMemo(() => computeArray3DInstanceCount(axes), [axes]);
  const budget = useMemo(
    () => computeArray3DBudgetStatus(totalInstances, realization),
    [realization, totalInstances],
  );
  const worldBounds = useMemo(
    () => computeArray3DWorldBounds(axes, childBounds),
    [axes, childBounds],
  );

  const updateAxis = useCallback(
    (index: 0 | 1 | 2, patch: Partial<ArrayAxisSpec>) => {
      const nextAxes: Array3DAxes = [axes[0], axes[1], axes[2]];
      nextAxes[index] = { ...axes[index], ...patch };
      onChange({ ...value, axes: nextAxes });
    },
    [axes, onChange, value],
  );

  const updateAxisTuple = useCallback(
    (
      index: 0 | 1 | 2,
      field: "step_translation_extra_m" | "step_rotation_euler_deg" | "step_scale_factor",
      component: 0 | 1 | 2,
      nextComponentValue: number,
    ) => {
      const nextAxes: Array3DAxes = [axes[0], axes[1], axes[2]];
      const tuple: Vec3Tuple = [...axes[index][field]];
      tuple[component] = nextComponentValue;
      nextAxes[index] = { ...axes[index], [field]: tuple };
      onChange({ ...value, axes: nextAxes });
    },
    [axes, onChange, value],
  );

  const handleApplyPreset = useCallback(
    (presetId: Array3DPresetId) => {
      const pitchRef = Math.max(childBounds.size[0], childBounds.size[1], 100e-9);
      onChange({ ...value, axes: applyArray3DPreset(presetId, pitchRef) });
    },
    [childBounds.size, onChange, value],
  );

  const realizationOptions = useMemo(
    () => [
      { label: "Modifier in Object", value: "modifier_in_object" as ArrayRealizationMode },
      {
        disabled: !budget.canExpandToObjects || disableExpandToObjects,
        label: `Expand to Objects (\u2264 ${MAX_EXPANDED_SCENE_OBJECTS})`,
        value: "expand_to_objects" as ArrayRealizationMode,
      },
    ],
    [budget.canExpandToObjects, disableExpandToObjects],
  );

  const unitScale = UNIT_SCALE_M[unit];

  return (
    <div
      className="fm-array3d-section flex min-w-0 flex-col gap-3"
      data-slot="array3d-lattice-section"
    >
      {/* 1-click Presets & Display Unit */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {PRESET_ITEMS.map((preset) => (
            <Button
              key={preset.id}
              disabled={disabled}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => handleApplyPreset(preset.id)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <SegmentedControl
            aria-label="Lattice length unit"
            className="w-28"
            columns={3}
            options={UNIT_OPTIONS}
            value={unit}
            onValueChange={handleUnitChange}
          />
          {onRemoveModifier ? (
            <Button
              aria-label="Remove Array 3D modifier"
              disabled={disabled}
              size="sm"
              type="button"
              variant="ghost"
              onClick={onRemoveModifier}
            >
              <X aria-hidden="true" size={13} />
              <span>Remove</span>
            </Button>
          ) : null}
        </div>
      </div>

      {/* Primary Semantic Table: X / Y / Z Lattice Axes */}
      <div className="fm-array3d-table-wrap overflow-x-auto rounded border border-[var(--fm-border-subtle)]">
        <table className="fm-array3d-table w-full border-collapse text-left text-xs">
          <caption className="sr-only">
            Array 3D lattice axes configuration (X, Y, Z)
          </caption>
          <thead>
            <tr className="border-b border-[var(--fm-border-subtle)] bg-[var(--fm-surface-subtle)] text-[var(--fm-text-secondary)]">
              <th scope="col" className="px-2 py-1.5 font-medium">Axis</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Active</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Count N</th>
              <th scope="col" className="px-2 py-1.5 font-medium">Direction</th>
              <th scope="col" className="px-2 py-1.5 font-medium">
                Pitch &Delta; / Gap g ({UNIT_LABELS[unit]})
              </th>
              <th scope="col" className="px-2 py-1.5 font-medium">
                Axis Span ({UNIT_LABELS[unit]})
              </th>
            </tr>
          </thead>
          <tbody>
            {([0, 1, 2] as const).map((idx) => {
              const spec = axes[idx];
              const axisUpper = spec.axis.toUpperCase();
              const isGap = spec.spacing_mode === "bounding_box_gap";
              const spanMeters = axisSpanM(spec, childBounds.size);
              const axisDisabled = disabled || !spec.enabled;
              return (
                <tr
                  key={spec.axis}
                  className="fm-array3d-row border-b border-[var(--fm-border-subtle)] last:border-b-0"
                  data-array-axis={spec.axis}
                >
                  <th
                    scope="row"
                    className="fm-array3d-axis-cell px-2 py-1.5 font-semibold text-[var(--fm-text-primary)]"
                  >
                    {axisUpper}
                  </th>
                  <td className="fm-array3d-cell px-2 py-1.5" data-label="Active">
                    <Switch
                      aria-label={`Enable ${axisUpper} axis`}
                      checked={spec.enabled}
                      disabled={disabled}
                      onCheckedChange={(checked) =>
                        updateAxis(idx, {
                          count: checked && spec.count < 2 ? 2 : spec.count,
                          enabled: Boolean(checked),
                        })
                      }
                    />
                  </td>
                  <td className="fm-array3d-cell px-2 py-1.5" data-label="Count N">
                    <Input
                      aria-label={`${axisUpper} count`}
                      className="fm-array3d-input--count w-16"
                      disabled={axisDisabled}
                      max={MAX_ARRAY_AXIS_COUNT}
                      min={1}
                      step={1}
                      type="number"
                      value={spec.count}
                      onChange={(event) => {
                        const parsed = Math.max(
                          1,
                          Math.min(
                            MAX_ARRAY_AXIS_COUNT,
                            Math.round(parseDisplayNumber(event.target.value, spec.count)),
                          ),
                        );
                        updateAxis(idx, { count: parsed });
                      }}
                    />
                  </td>
                  <td className="fm-array3d-cell px-2 py-1.5" data-label="Direction">
                    <SegmentedControl
                      aria-label={`${axisUpper} direction`}
                      className="w-24"
                      columns={3}
                      disabled={axisDisabled}
                      options={DIRECTION_OPTIONS}
                      value={spec.direction}
                      onValueChange={(nextDir) => updateAxis(idx, { direction: nextDir })}
                    />
                  </td>
                  <td
                    className="fm-array3d-cell px-2 py-1.5"
                    data-label={`${isGap ? "Gap g" : "Pitch \u0394"} (${UNIT_LABELS[unit]})`}
                  >
                    <div className="fm-array3d-pitch-group flex items-center gap-1">
                      <Button
                        aria-label={`Toggle ${axisUpper} spacing mode`}
                        disabled={axisDisabled}
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          updateAxis(idx, {
                            spacing_mode: isGap ? "lattice_step" : "bounding_box_gap",
                          })
                        }
                      >
                        {isGap ? "Gap" : "Pitch"}
                      </Button>
                      <Input
                        aria-label={`${axisUpper} ${isGap ? "gap" : "pitch"} (${UNIT_LABELS[unit]})`}
                        className="fm-array3d-input--pitch w-20"
                        disabled={axisDisabled}
                        step="any"
                        type="number"
                        value={formatInUnit(isGap ? spec.gap_m : spec.pitch_m, unit)}
                        onChange={(event) => {
                          const valM =
                            parseDisplayNumber(
                              event.target.value,
                              (isGap ? spec.gap_m : spec.pitch_m) / unitScale,
                            ) * unitScale;
                          updateAxis(idx, isGap ? { gap_m: valM } : { pitch_m: valM });
                        }}
                      />
                    </div>
                  </td>
                  <td
                    className="fm-array3d-cell px-2 py-1.5 font-mono text-[var(--fm-text-secondary)]"
                    data-label={`Axis Span (${UNIT_LABELS[unit]})`}
                  >
                    {formatInUnit(spanMeters, unit)} {UNIT_LABELS[unit]}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Collapsible Secondary Semantic Table: Bravais Skew / Step Rotation / Step Scale */}
      <div className="flex flex-col gap-2">
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => setShowAdvancedTable((prev) => !prev)}
        >
          {showAdvancedTable ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>Bravais Skew, Step Rotation &amp; Step Scale</span>
        </Button>

        {showAdvancedTable ? (
          <div className="fm-array3d-table-wrap overflow-x-auto rounded border border-[var(--fm-border-subtle)]">
            <table className="fm-array3d-table fm-array3d-table--advanced w-full border-collapse text-left text-xs">
              <caption className="sr-only">
                Bravais skew extra offset, step rotation, and step scale per lattice axis
              </caption>
              <thead>
                <tr className="border-b border-[var(--fm-border-subtle)] bg-[var(--fm-surface-subtle)] text-[var(--fm-text-secondary)]">
                  <th scope="col" className="px-2 py-1.5 font-medium">Axis</th>
                  <th scope="col" className="px-2 py-1.5 font-medium">
                    Extra Offset (dx, dy, dz) [{UNIT_LABELS[unit]}]
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-medium">
                    Step Rotation (rx, ry, rz)&deg;
                  </th>
                  <th scope="col" className="px-2 py-1.5 font-medium">
                    Step Scale (sx, sy, sz)
                  </th>
                </tr>
              </thead>
              <tbody>
                {([0, 1, 2] as const).map((idx) => {
                  const spec = axes[idx];
                  const axisUpper = spec.axis.toUpperCase();
                  const axisDisabled = disabled || !spec.enabled;
                  return (
                    <tr
                      key={spec.axis}
                      className="fm-array3d-row border-b border-[var(--fm-border-subtle)] last:border-b-0"
                    >
                      <th
                        scope="row"
                        className="fm-array3d-axis-cell px-2 py-1.5 font-semibold text-[var(--fm-text-primary)]"
                      >
                        {axisUpper}
                      </th>
                      <td
                        className="fm-array3d-cell fm-array3d-cell--stacked px-2 py-1.5"
                        data-label={`Extra Offset [${UNIT_LABELS[unit]}]`}
                      >
                        <div className="fm-array3d-tuple-grid flex items-center gap-1">
                          {([0, 1, 2] as const).map((c) => (
                            <Input
                              key={c}
                              aria-label={`${axisUpper} extra offset ${["x", "y", "z"][c]}`}
                              className="w-14"
                              disabled={axisDisabled}
                              step="any"
                              type="number"
                              value={formatInUnit(spec.step_translation_extra_m[c], unit)}
                              onChange={(event) => {
                                const valM =
                                  parseDisplayNumber(
                                    event.target.value,
                                    spec.step_translation_extra_m[c] / unitScale,
                                  ) * unitScale;
                                updateAxisTuple(idx, "step_translation_extra_m", c, valM);
                              }}
                            />
                          ))}
                        </div>
                      </td>
                      <td
                        className="fm-array3d-cell fm-array3d-cell--stacked px-2 py-1.5"
                        data-label="Step Rotation (\u00b0)"
                      >
                        <div className="fm-array3d-tuple-grid flex items-center gap-1">
                          {([0, 1, 2] as const).map((c) => (
                            <Input
                              key={c}
                              aria-label={`${axisUpper} step rotation ${["x", "y", "z"][c]}`}
                              className="w-14"
                              disabled={axisDisabled}
                              step="any"
                              type="number"
                              value={spec.step_rotation_euler_deg[c]}
                              onChange={(event) => {
                                const deg = parseDisplayNumber(
                                  event.target.value,
                                  spec.step_rotation_euler_deg[c],
                                );
                                updateAxisTuple(idx, "step_rotation_euler_deg", c, deg);
                              }}
                            />
                          ))}
                        </div>
                      </td>
                      <td
                        className="fm-array3d-cell fm-array3d-cell--stacked px-2 py-1.5"
                        data-label="Step Scale (sx, sy, sz)"
                      >
                        <div className="fm-array3d-tuple-grid flex items-center gap-1">
                          {([0, 1, 2] as const).map((c) => (
                            <Input
                              key={c}
                              aria-label={`${axisUpper} step scale ${["x", "y", "z"][c]}`}
                              className="w-14"
                              disabled={axisDisabled}
                              min={0.01}
                              step={0.05}
                              type="number"
                              value={spec.step_scale_factor[c]}
                              onChange={(event) => {
                                const factor = Math.max(
                                  0.01,
                                  parseDisplayNumber(
                                    event.target.value,
                                    spec.step_scale_factor[c],
                                  ),
                                );
                                updateAxisTuple(idx, "step_scale_factor", c, factor);
                              }}
                            />
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>

      {/* Realization Mode & Merge Overlapping */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-surface-subtle)] p-2">
        <SegmentedControl
          aria-label="Array 3D realization mode"
          className="min-w-0 flex-1"
          columns={2}
          disabled={disabled}
          options={realizationOptions}
          value={realization}
          onValueChange={(nextRealization) =>
            onChange({ ...value, realization: nextRealization })
          }
        />
        <div className="flex items-center gap-2 text-xs text-[var(--fm-text-secondary)]">
          <span>Merge overlapping</span>
          <Switch
            aria-label="Merge overlapping instances"
            checked={mergeOverlapping}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({ ...value, mergeOverlapping: Boolean(checked) })
            }
          />
        </div>
      </div>

      {/* Lattice Summary Bar (staged into footer CommitBar — no nested Apply button) */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--fm-border-subtle)] px-2.5 py-2 text-xs"
        data-slot="array3d-lattice-summary"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={
              budget.level === "error"
                ? "danger"
                : budget.level === "warn"
                  ? "warning"
                  : "success"
            }
          >
            {totalInstances.toLocaleString()} instances
          </Badge>
          <span className="font-mono text-[var(--fm-text-secondary)]">
            AABB: {formatInUnit(worldBounds.size[0], unit)} &times;{" "}
            {formatInUnit(worldBounds.size[1], unit)} &times;{" "}
            {formatInUnit(worldBounds.size[2], unit)} {UNIT_LABELS[unit]}
          </span>
        </div>
      </div>

      <p className="text-xs text-[var(--fm-text-muted)]">{budget.message}</p>
    </div>
  );
}
