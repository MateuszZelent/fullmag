"use client";

import { Grid3X3 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  defaultArray3DAxes,
  parseArray3DGeometry,
} from "@/kernel/authoring/array3dModel";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import {
  Array3DLatticeTableSection,
  resolveArray3DChildBoundsMeters,
  type DisplayLengthUnit,
} from "./Array3DLatticeTableSection";
import {
  extractTransformVectors,
  resolveGeometryNodeByPath,
} from "./geometryNodeTreeOps";
import {
  parseSymmetryAxis,
  type Array3DDraftConfig,
  type InlineOperandEditPatch,
} from "./geometryShared";

const AXIS_OPTIONS: readonly { label: string; value: "x" | "y" | "z" }[] = [
  { label: "X", value: "x" },
  { label: "Y", value: "y" },
  { label: "Z", value: "z" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatNm(meters: number): string {
  const nm = meters * 1e9;
  if (!Number.isFinite(nm)) return "0";
  return String(Number(nm.toFixed(3)));
}

function InlineNmInput({
  ariaLabel,
  autoFocus = false,
  disabled = false,
  min,
  valueMeters,
  onChangeMeters,
}: {
  ariaLabel: string;
  autoFocus?: boolean;
  disabled?: boolean;
  min?: number;
  valueMeters: number;
  onChangeMeters: (nextMeters: number) => void;
}) {
  const canonical = formatNm(valueMeters);
  const [rawText, setRawText] = useState(canonical);
  const [prevMeters, setPrevMeters] = useState(valueMeters);
  const [lastEmitted, setLastEmitted] = useState(valueMeters);

  if (!Object.is(valueMeters, prevMeters)) {
    setPrevMeters(valueMeters);
    if (!Object.is(valueMeters, lastEmitted)) {
      setLastEmitted(valueMeters);
      setRawText(canonical);
    }
  }

  return (
    <Input
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      className="h-7 min-w-0 flex-1 font-mono text-xs"
      disabled={disabled}
      inputMode="decimal"
      spellCheck={false}
      type="text"
      value={rawText}
      onBlur={() => {
        const parsed = Number(rawText.trim());
        if (Number.isFinite(parsed) && (min === undefined || parsed > min)) {
          const meters = parsed * 1e-9;
          setLastEmitted(meters);
          if (!Object.is(meters, valueMeters)) {
            onChangeMeters(meters);
          }
          setRawText(formatNm(meters));
        } else {
          setRawText(canonical);
        }
      }}
      onChange={(event) => {
        const nextText = event.target.value;
        setRawText(nextText);
        const trimmed = nextText.trim();
        if (trimmed.length === 0) return;
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed) && (min === undefined || parsed > min)) {
          const meters = parsed * 1e-9;
          setLastEmitted(meters);
          if (!Object.is(meters, valueMeters)) {
            onChangeMeters(meters);
          }
        }
      }}
    />
  );
}

export interface InlineNodeFieldsProps {
  rootGeometry: unknown;
  nodePath: string;
  sceneObj: unknown;
  patches: Readonly<Record<string, InlineOperandEditPatch>>;
  onPatchNode: (targetPath: string, patch: Partial<InlineOperandEditPatch>) => void;
  autoFocusPrimaryField?: boolean;
  disabled?: boolean;
  parentBaseThicknessM?: number | null;
  showArrayModifierEditor?: boolean;
  unit: DisplayLengthUnit;
  onUnitChange: (unit: DisplayLengthUnit) => void;
}

/**
 * Compact inline editor for an expanded Geometry Stack row:
 * edits unit primitive dimensions, local offset, and (when present) its controlled
 * Array 3D lattice table — all staged directly into the single footer CommitBar.
 */
export function InlineNodeFields({
  rootGeometry,
  nodePath,
  sceneObj,
  patches,
  onPatchNode,
  autoFocusPrimaryField = false,
  disabled = false,
  parentBaseThicknessM = null,
  showArrayModifierEditor = true,
  unit,
  onUnitChange,
}: InlineNodeFieldsProps) {
  const resolvedNode = useMemo(
    () => resolveGeometryNodeByPath(rootGeometry, nodePath),
    [nodePath, rootGeometry],
  );

  const nodePatch = patches[nodePath];
  const parsedExistingArray = useMemo(
    () => (resolvedNode ? parseArray3DGeometry(resolvedNode.geometry) : null),
    [resolvedNode],
  );

  const effectiveArrayConfig: Array3DDraftConfig | null = useMemo(() => {
    if (nodePatch?.array3dConfig !== undefined) {
      return nodePatch.array3dConfig;
    }
    if (!parsedExistingArray) return null;
    return {
      axes: parsedExistingArray.axes,
      mergeOverlapping: parsedExistingArray.mergeOverlapping,
      realization: "modifier_in_object",
    };
  }, [nodePatch, parsedExistingArray]);

  // If the node is an Array3D, unit primitive edits target `${nodePath}/array-child`.
  const unitPath = resolvedNode?.isArray3D && resolvedNode.arrayChildPath
    ? resolvedNode.arrayChildPath
    : nodePath;
  const resolvedUnit = useMemo(
    () =>
      unitPath === nodePath
        ? resolvedNode
        : resolveGeometryNodeByPath(rootGeometry, unitPath),
    [nodePath, resolvedNode, rootGeometry, unitPath],
  );
  const unitPatch = patches[unitPath];

  const childBounds = useMemo(
    () =>
      resolveArray3DChildBoundsMeters(
        sceneObj,
        resolvedNode?.geometry ?? rootGeometry,
      ),
    [resolvedNode?.geometry, rootGeometry, sceneObj],
  );

  const patchUnit = useCallback(
    (partial: Partial<InlineOperandEditPatch>) => {
      onPatchNode(unitPath, partial);
    },
    [onPatchNode, unitPath],
  );

  if (!resolvedNode) {
    return null;
  }

  const unitParams =
    asRecord(resolvedUnit?.geometry.geometry_params) ??
    asRecord(resolvedUnit?.geometry.params) ??
    {};
  const sizeArr = Array.isArray(unitParams.size) ? unitParams.size : null;
  const radiiArr = Array.isArray(unitParams.radii) ? unitParams.radii : null;
  const unitKind = resolvedUnit?.geometryKind ?? resolvedNode.geometryKind;
  const isEditablePrimitive = Boolean(resolvedUnit?.isEditablePrimitive);
  const txVecs = extractTransformVectors(resolvedUnit?.transform ?? null);

  const symmetryAxis = unitPatch?.symmetryAxis ?? parseSymmetryAxis(unitParams.axis);
  const sizeX =
    unitPatch?.sizeX ??
    (sizeArr ? numberOr(sizeArr[0], 100e-9) : radiiArr ? numberOr(radiiArr[0], 50e-9) * 2 : 100e-9);
  const sizeY =
    unitPatch?.sizeY ??
    (sizeArr ? numberOr(sizeArr[1], 100e-9) : radiiArr ? numberOr(radiiArr[1], 50e-9) * 2 : 100e-9);
  const sizeZ =
    unitPatch?.sizeZ ??
    (sizeArr ? numberOr(sizeArr[2], 10e-9) : radiiArr ? numberOr(radiiArr[2], 10e-9) * 2 : 10e-9);
  const radius =
    unitPatch?.radius ??
    numberOr(unitParams.radius ?? unitParams.radius_bottom ?? unitParams.major_radius, 25e-9);
  const height =
    unitPatch?.height ??
    numberOr(unitParams.height ?? unitParams.length ?? unitParams.thickness, 20e-9);
  const bottomRadius =
    unitPatch?.bottomRadius ??
    numberOr(unitParams.radius_bottom ?? unitParams.bottom_radius, 50e-9);
  const topRadius =
    unitPatch?.topRadius ??
    numberOr(unitParams.radius_top ?? unitParams.top_radius, 25e-9);
  const majorRadius = unitPatch?.majorRadius ?? numberOr(unitParams.major_radius, 80e-9);
  const minorRadius = unitPatch?.minorRadius ?? numberOr(unitParams.minor_radius, 20e-9);
  const translation = unitPatch?.translation ?? txVecs.translation;

  const autoThroughHeightM =
    parentBaseThicknessM && parentBaseThicknessM > 0 ? parentBaseThicknessM * 1.2 : null;

  return (
    <div
      className="mt-2 flex flex-col gap-2.5 border-t border-[var(--fm-border-subtle)] pt-2.5"
      data-slot="geometry-stack-inline-editor"
    >
      {/* Shape / Unit Geometry Dimensions */}
      {isEditablePrimitive ? (
        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium text-[var(--fm-text-secondary)]">
            {resolvedNode.isArray3D ? `Unit Geometry (${unitKind})` : `Shape (${unitKind})`}
          </div>

          {unitKind === "Cylinder" || unitKind === "Cone" || unitKind === "Torus" ? (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-[var(--fm-text-muted)]">Principal axis</span>
              <SegmentedControl
                aria-label={`${resolvedNode.label} principal axis`}
                className="w-28"
                columns={3}
                disabled={disabled}
                options={AXIS_OPTIONS}
                value={symmetryAxis}
                onValueChange={(nextAxis) => patchUnit({ symmetryAxis: nextAxis })}
              />
            </div>
          ) : null}

          {unitKind === "Box" || unitKind === "Ellipsoid" ? (
            <div className="grid grid-cols-3 gap-1.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-[var(--fm-text-muted)]">Lx (nm)</span>
                <InlineNmInput
                  ariaLabel={`${resolvedNode.label} extent X (nm)`}
                  autoFocus={autoFocusPrimaryField}
                  disabled={disabled}
                  min={0}
                  valueMeters={sizeX}
                  onChangeMeters={(nextX) => patchUnit({ sizeX: nextX, sizeY, sizeZ })}
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-[var(--fm-text-muted)]">Ly (nm)</span>
                <InlineNmInput
                  ariaLabel={`${resolvedNode.label} extent Y (nm)`}
                  disabled={disabled}
                  min={0}
                  valueMeters={sizeY}
                  onChangeMeters={(nextY) => patchUnit({ sizeX, sizeY: nextY, sizeZ })}
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-[var(--fm-text-muted)]">Lz (nm)</span>
                <InlineNmInput
                  ariaLabel={`${resolvedNode.label} thickness Z (nm)`}
                  disabled={disabled}
                  min={0}
                  valueMeters={sizeZ}
                  onChangeMeters={(nextZ) => patchUnit({ sizeX, sizeY, sizeZ: nextZ })}
                />
              </div>
            </div>
          ) : null}

          {unitKind === "Cylinder" || unitKind === "Sphere" ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-xs text-[var(--fm-text-muted)]">Radius R (nm)</span>
                <InlineNmInput
                  ariaLabel={`${resolvedNode.label} radius (nm)`}
                  autoFocus={autoFocusPrimaryField}
                  disabled={disabled}
                  min={0}
                  valueMeters={radius}
                  onChangeMeters={(nextR) => patchUnit({ radius: nextR })}
                />
              </div>
              {unitKind === "Cylinder" ? (
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-xs text-[var(--fm-text-muted)]">Height h (nm)</span>
                  <div className="flex items-center gap-1">
                    <InlineNmInput
                      ariaLabel={`${resolvedNode.label} height (nm)`}
                      disabled={disabled}
                      min={0}
                      valueMeters={height}
                      onChangeMeters={(nextH) => patchUnit({ height: nextH })}
                    />
                    {autoThroughHeightM !== null ? (
                      <Button
                        aria-label={`Set ${resolvedNode.label} height to 1.2x thickness`}
                        disabled={disabled}
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() => patchUnit({ height: autoThroughHeightM })}
                      >
                        Auto
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {unitKind === "Cone" ? (
            <div className="grid grid-cols-3 gap-1.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-[var(--fm-text-muted)]">R1 (nm)</span>
                <InlineNmInput
                  ariaLabel={`${resolvedNode.label} bottom radius (nm)`}
                  autoFocus={autoFocusPrimaryField}
                  disabled={disabled}
                  valueMeters={bottomRadius}
                  onChangeMeters={(v) => patchUnit({ bottomRadius: Math.max(0, v) })}
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-[var(--fm-text-muted)]">R2 (nm)</span>
                <InlineNmInput
                  ariaLabel={`${resolvedNode.label} top radius (nm)`}
                  disabled={disabled}
                  valueMeters={topRadius}
                  onChangeMeters={(v) => patchUnit({ topRadius: Math.max(0, v) })}
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-[var(--fm-text-muted)]">Height (nm)</span>
                <InlineNmInput
                  ariaLabel={`${resolvedNode.label} height (nm)`}
                  disabled={disabled}
                  min={0}
                  valueMeters={height}
                  onChangeMeters={(v) => patchUnit({ height: v })}
                />
              </div>
            </div>
          ) : null}

          {unitKind === "Torus" ? (
            <div className="grid grid-cols-2 gap-1.5">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-[var(--fm-text-muted)]">Major R (nm)</span>
                <InlineNmInput
                  ariaLabel={`${resolvedNode.label} major radius (nm)`}
                  autoFocus={autoFocusPrimaryField}
                  disabled={disabled}
                  min={0}
                  valueMeters={majorRadius}
                  onChangeMeters={(v) => patchUnit({ majorRadius: v })}
                />
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-[var(--fm-text-muted)]">Minor r (nm)</span>
                <InlineNmInput
                  ariaLabel={`${resolvedNode.label} minor radius (nm)`}
                  disabled={disabled}
                  min={0}
                  valueMeters={minorRadius}
                  onChangeMeters={(v) => patchUnit({ minorRadius: v })}
                />
              </div>
            </div>
          ) : null}

          {/* Local Offset (x, y, z) */}
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-[var(--fm-text-muted)]">Local offset (x, y, z) nm</span>
            <div className="grid grid-cols-3 gap-1.5">
              {([0, 1, 2] as const).map((axisIdx) => (
                <InlineNmInput
                  key={axisIdx}
                  ariaLabel={`${resolvedNode.label} offset ${["x", "y", "z"][axisIdx]} (nm)`}
                  disabled={disabled}
                  valueMeters={translation[axisIdx]}
                  onChangeMeters={(val) => {
                    const nextTx: [number, number, number] = [
                      translation[0],
                      translation[1],
                      translation[2],
                    ];
                    nextTx[axisIdx] = val;
                    patchUnit({ translation: nextTx });
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <p className="text-xs text-[var(--fm-text-muted)]">
          Nested {resolvedNode.geometryKind} node — use the row menu to open in Node Inspector for
          deep editing.
        </p>
      )}

      {/* Controlled Inline Array 3D Modifier */}
      {showArrayModifierEditor && effectiveArrayConfig ? (
        <div
          className="flex flex-col gap-2 rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-surface-1)] p-2"
          data-slot="inline-operand-array3d"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--fm-text-secondary)]">
            <Grid3X3 aria-hidden="true" size={13} />
            <span>Array 3D Modifier</span>
          </div>
          <Array3DLatticeTableSection
            childBounds={childBounds}
            disableExpandToObjects
            disabled={disabled}
            unit={unit}
            value={effectiveArrayConfig}
            onChange={(nextCfg) => onPatchNode(nodePath, { array3dConfig: nextCfg })}
            onRemoveModifier={() => onPatchNode(nodePath, { array3dConfig: null })}
            onUnitChange={onUnitChange}
          />
        </div>
      ) : showArrayModifierEditor && resolvedNode.isTopLevelBooleanOperand ? (
        <div className="flex items-center justify-end">
          <Button
            disabled={disabled}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() =>
              onPatchNode(nodePath, {
                array3dConfig: {
                  axes: defaultArray3DAxes(),
                  mergeOverlapping: false,
                  realization: "modifier_in_object",
                },
              })
            }
          >
            <Grid3X3 aria-hidden="true" size={13} />
            <span>Add Array 3D Modifier</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
