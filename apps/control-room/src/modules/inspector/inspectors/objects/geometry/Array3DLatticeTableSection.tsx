"use client";

import { ChevronDown, ChevronRight, Grid3X3 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import {
  applyArray3DPreset,
  axisSpanM,
  computeArray3DBudgetStatus,
  computeArray3DInstanceCount,
  computeArray3DWorldBounds,
  defaultArray3DAxes,
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
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { applyArray3DTransaction } from "@/kernel/authoring/geometryLifecycleCommands";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import type { KernelApi } from "@/kernel/types";
import { parseCompositeGeometry } from "@/modules/explorer/builders/geometryTreeExplorerNodes";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Switch } from "@/shared/ui/Switch";

type DisplayLengthUnit = "nm" | "um" | "mm";

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

const PRESET_ITEMS: readonly { id: Array3DPresetId; label: string }[] = [
  { id: "rectangular_xy", label: "Rectangular XY" },
  { id: "hexagonal_xy", label: "Hexagonal XY" },
  { id: "multilayer_z", label: "Multilayer Z" },
  { id: "stripe_1d", label: "1D Stripe" },
];

const DIRECTION_ITEMS: readonly { label: string; value: ArrayDirection }[] = [
  { label: "+", value: "positive" },
  { label: "\u2212", value: "negative" },
  { label: "\u00b1", value: "symmetric" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readChildBounds(
  sceneObj: unknown,
): { max: Vec3Tuple; min: Vec3Tuple; size: Vec3Tuple } {
  const objRec = asRecord(sceneObj);
  const geomRec = asRecord(objRec?.geometry);
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
  kernel: KernelApi;
  objectId: string;
  sceneData: SceneResource | null | undefined;
  sessionScopeKey: string | null;
  targetOperandId?: string;
}

export function Array3DLatticeTableSection({
  kernel,
  objectId,
  sceneData,
  sessionScopeKey,
  targetOperandId,
}: Array3DLatticeTableSectionProps) {
  const sceneObj = sceneData?.objects?.find((item) => item.id === objectId) ?? null;
  const sceneGeometry = sceneObj?.geometry ?? null;
  const targetGeometry = useMemo(() => {
    if (!sceneGeometry) return null;
    if (!targetOperandId) return sceneGeometry;
    const composite = parseCompositeGeometry(sceneGeometry);
    return (
      composite.operands.find((op) => op.operandId === targetOperandId)?.geometry ?? null
    );
  }, [sceneGeometry, targetOperandId]);
  const parsedExisting = useMemo(
    () => parseArray3DGeometry(targetGeometry),
    [targetGeometry],
  );
  const childBounds = useMemo(() => readChildBounds(sceneObj), [sceneObj]);

  const targetKey = `${objectId}:${targetOperandId ?? ""}`;
  const [prevTargetKey, setPrevTargetKey] = useState(targetKey);
  const [axes, setAxes] = useState<Array3DAxes>(
    () => parsedExisting?.axes ?? defaultArray3DAxes(),
  );
  const [unit, setUnit] = useState<DisplayLengthUnit>("nm");
  const [realization, setRealization] = useState<ArrayRealizationMode>("modifier_in_object");
  const [mergeOverlapping, setMergeOverlapping] = useState<boolean>(
    () => parsedExisting?.mergeOverlapping ?? false,
  );
  if (prevTargetKey !== targetKey) {
    setPrevTargetKey(targetKey);
    setAxes(parsedExisting?.axes ?? defaultArray3DAxes());
    setMergeOverlapping(parsedExisting?.mergeOverlapping ?? false);
  }
  const [showAdvancedTable, setShowAdvancedTable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const baseRevision =
    typeof sceneData?.revision === "number" && Number.isFinite(sceneData.revision)
      ? sceneData.revision
      : null;

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
      setAxes((current) => {
        const next: Array3DAxes = [current[0], current[1], current[2]];
        next[index] = { ...current[index], ...patch };
        return next;
      });
    },
    [],
  );

  const updateAxisTuple = useCallback(
    (
      index: 0 | 1 | 2,
      field: "step_translation_extra_m" | "step_rotation_euler_deg" | "step_scale_factor",
      component: 0 | 1 | 2,
      value: number,
    ) => {
      setAxes((current) => {
        const next: Array3DAxes = [current[0], current[1], current[2]];
        const tuple: Vec3Tuple = [...current[index][field]];
        tuple[component] = value;
        next[index] = { ...current[index], [field]: tuple };
        return next;
      });
    },
    [],
  );

  const handleApplyPreset = useCallback(
    (presetId: Array3DPresetId) => {
      const pitchRef = Math.max(childBounds.size[0], childBounds.size[1], 100e-9);
      setAxes(applyArray3DPreset(presetId, pitchRef));
    },
    [childBounds.size],
  );

  const handleApplyArray = useCallback(async () => {
    if (busy || baseRevision === null || budget.level === "error") return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const response = await applyArray3DTransaction(
        kernel.api,
        {
          axes,
          base_revision: baseRevision,
          merge_overlapping: mergeOverlapping,
          object_id: objectId,
          realization,
          ...(targetOperandId ? { target_operand_id: targetOperandId } : {}),
        },
        sessionScopeKey ? { sessionScopeKey } : undefined,
      );
      const rev = acknowledgedAuthoringSceneRevision(response);
      publishCommittedSceneResource(
        kernel.resources,
        response.committed_scene,
        rev,
        undefined,
        false,
        sessionScopeKey,
        kernel.api.resourceCacheScope,
      );
      invalidateAuthoringMutationDependents(kernel.resources, "geometry", rev);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not apply Array 3D lattice.",
      );
    } finally {
      setBusy(false);
    }
  }, [
    axes,
    baseRevision,
    budget.level,
    busy,
    kernel.api,
    kernel.resources,
    mergeOverlapping,
    objectId,
    realization,
    sessionScopeKey,
    targetOperandId,
  ]);

  const unitScale = UNIT_SCALE_M[unit];

  return (
    <div
      className="flex flex-col gap-3 @container"
      data-slot="array3d-lattice-section"
    >
      {/* 1-click Presets & Display Unit */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {PRESET_ITEMS.map((preset) => (
            <Button
              key={preset.id}
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => handleApplyPreset(preset.id)}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Lattice length unit">
          {(["nm", "um", "mm"] as const).map((candidate) => (
            <Button
              key={candidate}
              size="sm"
              type="button"
              variant={unit === candidate ? "primary" : "ghost"}
              onClick={() => setUnit(candidate)}
            >
              {UNIT_LABELS[candidate]}
            </Button>
          ))}
        </div>
      </div>

      {/* Primary Semantic Table: X / Y / Z Lattice Axes */}
      <div className="overflow-x-auto rounded border border-[var(--fm-border-subtle)]">
        <table className="w-full border-collapse text-left text-xs">
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
              return (
                <tr
                  key={spec.axis}
                  className="border-b border-[var(--fm-border-subtle)] last:border-b-0"
                  data-array-axis={spec.axis}
                >
                  <th scope="row" className="px-2 py-1.5 font-semibold text-[var(--fm-text-primary)]">
                    {axisUpper}
                  </th>
                  <td className="px-2 py-1.5">
                    <Switch
                      aria-label={`Enable ${axisUpper} axis`}
                      checked={spec.enabled}
                      onCheckedChange={(checked) =>
                        updateAxis(idx, {
                          count: checked && spec.count < 2 ? 2 : spec.count,
                          enabled: Boolean(checked),
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      aria-label={`${axisUpper} count`}
                      className="w-16"
                      disabled={!spec.enabled}
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
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-0.5">
                      {DIRECTION_ITEMS.map((dir) => (
                        <Button
                          key={dir.value}
                          aria-label={`${axisUpper} direction ${dir.value}`}
                          disabled={!spec.enabled}
                          size="sm"
                          type="button"
                          variant={spec.direction === dir.value ? "primary" : "ghost"}
                          onClick={() => updateAxis(idx, { direction: dir.value })}
                        >
                          {dir.label}
                        </Button>
                      ))}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <Button
                        aria-label={`Toggle ${axisUpper} spacing mode`}
                        disabled={!spec.enabled}
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
                        className="w-20"
                        disabled={!spec.enabled}
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
                  <td className="px-2 py-1.5 font-mono text-[var(--fm-text-secondary)]">
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
          <div className="overflow-x-auto rounded border border-[var(--fm-border-subtle)]">
            <table className="w-full border-collapse text-left text-xs">
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
                  return (
                    <tr
                      key={spec.axis}
                      className="border-b border-[var(--fm-border-subtle)] last:border-b-0"
                    >
                      <th scope="row" className="px-2 py-1.5 font-semibold text-[var(--fm-text-primary)]">
                        {axisUpper}
                      </th>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          {([0, 1, 2] as const).map((c) => (
                            <Input
                              key={c}
                              aria-label={`${axisUpper} extra offset ${["x", "y", "z"][c]}`}
                              className="w-14"
                              disabled={!spec.enabled}
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
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          {([0, 1, 2] as const).map((c) => (
                            <Input
                              key={c}
                              aria-label={`${axisUpper} step rotation ${["x", "y", "z"][c]}`}
                              className="w-14"
                              disabled={!spec.enabled}
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
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          {([0, 1, 2] as const).map((c) => (
                            <Input
                              key={c}
                              aria-label={`${axisUpper} step scale ${["x", "y", "z"][c]}`}
                              className="w-14"
                              disabled={!spec.enabled}
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
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="sm"
            type="button"
            variant={realization === "modifier_in_object" ? "primary" : "secondary"}
            onClick={() => setRealization("modifier_in_object")}
          >
            Modifier in Object
          </Button>
          <Button
            disabled={!budget.canExpandToObjects || Boolean(targetOperandId)}
            size="sm"
            type="button"
            variant={realization === "expand_to_objects" ? "primary" : "secondary"}
            onClick={() => setRealization("expand_to_objects")}
          >
            Expand to Objects (&le; {MAX_EXPANDED_SCENE_OBJECTS})
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--fm-text-secondary)]">
          <span>Merge overlapping</span>
          <Switch
            aria-label="Merge overlapping instances"
            checked={mergeOverlapping}
            onCheckedChange={(checked) => setMergeOverlapping(Boolean(checked))}
          />
        </div>
      </div>

      {/* Lattice Summary Bar */}
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
        <Button
          disabled={busy || baseRevision === null || budget.level === "error"}
          size="sm"
          type="button"
          variant="primary"
          onClick={() => {
            void handleApplyArray();
          }}
        >
          <Grid3X3 size={13} />
          <span>{busy ? "Applying…" : "Apply Array 3D"}</span>
        </Button>
      </div>

      <p className="text-xs text-[var(--fm-text-muted)]">{budget.message}</p>

      {errorMessage ? (
        <p className="text-xs text-[var(--fm-danger)]" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
