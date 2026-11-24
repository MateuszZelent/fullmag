"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Combine,
  ExternalLink,
  Eye,
  EyeOff,
  Grid3X3,
  MoreVertical,
  Plus,
  Scissors,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import {
  array3DDimensionsLabel,
  defaultArray3DAxes,
  parseArray3DGeometry,
} from "@/kernel/authoring/array3dModel";
import {
  applyArray3DTransaction,
  separateObjectTransaction,
  updateBooleanOperandsTransaction,
  type BooleanOperandOp,
} from "@/kernel/authoring/geometryLifecycleCommands";
import type { KernelApi } from "@/kernel/types";
import {
  geometryGhostVisibilityStore,
  geometryOperandGhostKey,
} from "@/kernel/visualization/geometryGhostVisibilityStore";
import {
  parseCompositeGeometry,
  type NormalizedGeometryOperand,
} from "@/kernel/authoring/compositeGeometryModel";
import { computeSceneGeometryBoundsMeters } from "@/shared/domain/geometry/sceneGeometryBounds";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { Switch } from "@/shared/ui/Switch";
import { cn } from "@/shared/utils/className";

import type { DisplayLengthUnit } from "./Array3DLatticeTableSection";
import { commitGeometryStackTransaction } from "./geometryHistoryRunner";
import { formatGeometryUnitSummary } from "./geometryNodeTreeOps";
import type { InlineOperandEditPatch } from "./geometryShared";
import { InlineNodeFields } from "./InlineNodeFields";

export type QuickCutoutKind = "Cylinder" | "Box" | "Sphere";

const BOOLEAN_OP_OPTIONS: readonly { label: string; value: BooleanOperandOp }[] = [
  { label: "Union", value: "union" },
  { label: "Subtract", value: "subtract" },
  { label: "Intersect", value: "intersect" },
  { label: "XOR", value: "xor" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * Compute cutout height automatically as `1.2 * L_z` from the target object's bounds
 * (falling back to `1.2 * fallbackThickness` when bounds are absent) so through-holes
 * cleanly pierce the target solid without coplanar z-fighting.
 */
export function computeCutoutHeightFromBounds(
  bounds: unknown,
  fallbackThicknessM = 20e-9,
): number {
  const rec = asRecord(bounds);
  const size = Array.isArray(rec?.size) ? rec.size : null;
  const lz = size ? finitePositive(size[2]) : null;
  if (lz !== null) return lz * 1.2;
  const min = Array.isArray(rec?.min) ? rec.min : null;
  const max = Array.isArray(rec?.max) ? rec.max : null;
  if (min && max) {
    const zMin = typeof min[2] === "number" ? min[2] : null;
    const zMax = typeof max[2] === "number" ? max[2] : null;
    if (zMin !== null && zMax !== null && Number.isFinite(zMax - zMin) && zMax > zMin) {
      return (zMax - zMin) * 1.2;
    }
  }
  return fallbackThicknessM * 1.2;
}

export function buildQuickCutoutGeometry(
  kind: QuickCutoutKind,
  bounds: unknown,
): JsonObject {
  const rec = asRecord(bounds);
  const size = Array.isArray(rec?.size) ? rec.size : null;
  const lx = (size ? finitePositive(size[0]) : null) ?? 100e-9;
  const ly = (size ? finitePositive(size[1]) : null) ?? 100e-9;
  const minXY = Math.min(lx, ly);
  const cutoutHeight = computeCutoutHeightFromBounds(bounds);

  if (kind === "Cylinder") {
    return {
      geometry_kind: "Cylinder",
      geometry_params: {
        axis: [0, 0, 1],
        height: cutoutHeight,
        radius: Math.max(minXY * 0.2, 5e-9),
      },
    };
  }
  if (kind === "Sphere") {
    return {
      geometry_kind: "Sphere",
      geometry_params: {
        radius: Math.max(Math.min(minXY, cutoutHeight) * 0.25, 5e-9),
      },
    };
  }
  const boxXY = Math.max(minXY * 0.3, 10e-9);
  return {
    geometry_kind: "Box",
    geometry_params: {
      size: [boxXY, boxXY, cutoutHeight],
    },
  };
}

function summarizeOperandSubtitle(
  operand: NormalizedGeometryOperand,
  patch: InlineOperandEditPatch | undefined,
): string | null {
  const existingArray = parseArray3DGeometry(operand.geometry);
  const effectiveArray =
    patch?.array3dConfig !== undefined
      ? patch.array3dConfig
      : existingArray
        ? { axes: existingArray.axes }
        : null;

  const baseGeometry = existingArray ? existingArray.child : operand.geometry;
  const baseSummary = formatGeometryUnitSummary(baseGeometry);
  if (effectiveArray) {
    const dimsLabel = array3DDimensionsLabel(effectiveArray.axes);
    return baseSummary ? `${baseSummary} \u00b7 ${dimsLabel}` : dimsLabel;
  }
  return baseSummary;
}

export interface BooleanNodeSectionProps {
  kernel: KernelApi;
  objectId: string;
  sceneData: SceneResource | null | undefined;
  sessionScopeKey: string | null;
  inlineNodePatches?: Readonly<Record<string, InlineOperandEditPatch>>;
  onPatchNode?: (targetPath: string, patch: Partial<InlineOperandEditPatch>) => void;
  hasDirtyDraft?: boolean;
  onFlushDraft?: () => Promise<boolean>;
  initialExpandedOperandId?: string | null;
  onExpandedOperandConsumed?: () => void;
  unit?: DisplayLengthUnit;
  onUnitChange?: (unit: DisplayLengthUnit) => void;
}

export function BooleanNodeSection({
  kernel,
  objectId,
  sceneData,
  sessionScopeKey,
  inlineNodePatches,
  onPatchNode,
  hasDirtyDraft = false,
  onFlushDraft,
  initialExpandedOperandId = null,
  onExpandedOperandConsumed,
  unit: controlledUnit,
  onUnitChange,
}: BooleanNodeSectionProps) {
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expandedOperandId, setExpandedOperandId] = useState<string | null>(
    initialExpandedOperandId,
  );
  const [autoFocusOperandId, setAutoFocusOperandId] = useState<string | null>(
    initialExpandedOperandId,
  );
  const [prevInitialExpanded, setPrevInitialExpanded] = useState<string | null>(
    initialExpandedOperandId,
  );
  const [fallbackUnit, setFallbackUnit] = useState<DisplayLengthUnit>("nm");

  if (initialExpandedOperandId !== prevInitialExpanded) {
    setPrevInitialExpanded(initialExpandedOperandId);
    if (initialExpandedOperandId) {
      setExpandedOperandId(initialExpandedOperandId);
      setAutoFocusOperandId(initialExpandedOperandId);
      onExpandedOperandConsumed?.();
    }
  }

  const unit = controlledUnit ?? fallbackUnit;
  const handleUnitChange = onUnitChange ?? setFallbackUnit;

  const ghostKeys = useSyncExternalStore(
    geometryGhostVisibilityStore.subscribe,
    geometryGhostVisibilityStore.getSnapshot,
    geometryGhostVisibilityStore.getServerSnapshot,
  );

  const sceneObj = sceneData?.objects?.find((obj) => obj.id === objectId) ?? null;
  const parsed = useMemo(
    () => parseCompositeGeometry(sceneObj?.geometry),
    [sceneObj?.geometry],
  );
  const baseRevision =
    typeof sceneData?.revision === "number" && Number.isFinite(sceneData.revision)
      ? sceneData.revision
      : null;

  const baseThicknessM = useMemo(() => {
    const firstOperand = parsed.operands[0];
    if (!firstOperand) return null;
    const bounds = computeSceneGeometryBoundsMeters(firstOperand.geometry);
    return bounds?.size[2] ?? null;
  }, [parsed.operands]);

  const commitOperandUpdate = useCallback(
    async (
      label: string,
      mutation: (rev: number) => Promise<{ committed_scene?: SceneResource; scene_revision?: number }>,
    ) => {
      if (busy || baseRevision === null) return null;
      setBusy(true);
      setErrorMessage(null);
      try {
        if (hasDirtyDraft && onFlushDraft) {
          const flushed = await onFlushDraft();
          if (!flushed) return null;
        }
        return await commitGeometryStackTransaction({
          kernel,
          label,
          sceneData,
          sessionScopeKey,
          execute: ({ baseRevision: historyRev }) =>
            mutation(historyRev ?? baseRevision),
        });
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : "Could not update boolean operand stack.",
        );
        return null;
      } finally {
        setBusy(false);
      }
    },
    [baseRevision, busy, hasDirtyDraft, kernel, onFlushDraft, sceneData, sessionScopeKey],
  );

  if (!sceneObj || parsed.operands.length === 0) {
    return null;
  }

  const requestOptions = sessionScopeKey ? { sessionScopeKey } : undefined;
  const currentOp: BooleanOperandOp =
    parsed.op === "union" ||
    parsed.op === "subtract" ||
    parsed.op === "intersect" ||
    parsed.op === "xor"
      ? parsed.op
      : "subtract";

  const handleChangeOp = (nextOp: BooleanOperandOp) => {
    if (baseRevision === null || nextOp === currentOp) return;
    void commitOperandUpdate(`Change Boolean operation to ${nextOp}`, (rev) =>
      updateBooleanOperandsTransaction(
        kernel.api,
        { base_revision: rev, object_id: objectId, op: nextOp },
        requestOptions,
      ),
    );
  };

  const handleToggleOperand = (operand: NormalizedGeometryOperand, enabled: boolean) => {
    if (onPatchNode) {
      onPatchNode(operand.operandId, { enabled });
      return;
    }
    if (baseRevision === null) return;
    void commitOperandUpdate(
      `${enabled ? "Enable" : "Disable"} operand ${operand.label}`,
      (rev) =>
        updateBooleanOperandsTransaction(
          kernel.api,
          {
            base_revision: rev,
            object_id: objectId,
            toggle_operand: { enabled, operand_id: operand.operandId },
          },
          requestOptions,
        ),
    );
  };

  const handleMoveOperand = (index: number, delta: -1 | 1) => {
    if (baseRevision === null) return;
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= parsed.operands.length) return;
    const nextIds = parsed.operands.map((item) => item.operandId);
    const [moved] = nextIds.splice(index, 1);
    nextIds.splice(targetIndex, 0, moved);
    void commitOperandUpdate(
      `Move operand ${parsed.operands[index]?.label ?? ""} ${delta < 0 ? "up" : "down"}`,
      (rev) =>
        updateBooleanOperandsTransaction(
          kernel.api,
          {
            base_revision: rev,
            object_id: objectId,
            reorder_operand_ids: nextIds,
          },
          requestOptions,
        ),
    );
  };

  const handleSwapBaseTool = () => {
    if (baseRevision === null || parsed.operands.length < 2) return;
    const nextIds = parsed.operands.map((item) => item.operandId);
    const first = nextIds[0];
    nextIds[0] = nextIds[1];
    nextIds[1] = first;
    void commitOperandUpdate("Swap Boolean base and tool operands", (rev) =>
      updateBooleanOperandsTransaction(
        kernel.api,
        {
          base_revision: rev,
          object_id: objectId,
          reorder_operand_ids: nextIds,
        },
        requestOptions,
      ),
    );
  };

  const handleRemoveOperand = (operand: NormalizedGeometryOperand) => {
    if (baseRevision === null || parsed.operands.length <= 1) return;
    void commitOperandUpdate(`Remove operand ${operand.label}`, (rev) =>
      updateBooleanOperandsTransaction(
        kernel.api,
        {
          base_revision: rev,
          object_id: objectId,
          remove_operand_id: operand.operandId,
        },
        requestOptions,
      ),
    );
  };

  const handleExtractOperand = (operand: NormalizedGeometryOperand) => {
    if (baseRevision === null) return;
    void commitOperandUpdate(`Extract ${operand.label} as object`, (rev) =>
      separateObjectTransaction(
        kernel.api,
        {
          base_revision: rev,
          keep_in_boolean: false,
          mode: "extract_operand",
          object_id: objectId,
          operand_id: operand.operandId,
        },
        requestOptions,
      ),
    );
  };

  const handleArrayOperand = (operand: NormalizedGeometryOperand) => {
    if (onPatchNode) {
      onPatchNode(operand.operandId, {
        array3dConfig: {
          axes: defaultArray3DAxes(),
          mergeOverlapping: false,
          realization: "modifier_in_object",
        },
      });
      setExpandedOperandId(operand.operandId);
      setAutoFocusOperandId(null);
      return;
    }
    if (baseRevision === null) return;
    void commitOperandUpdate(`Apply Array 3D to ${operand.label}`, (rev) =>
      applyArray3DTransaction(
        kernel.api,
        {
          axes: defaultArray3DAxes(),
          base_revision: rev,
          merge_overlapping: false,
          object_id: objectId,
          realization: "modifier_in_object",
          target_operand_id: operand.operandId,
        },
        requestOptions,
      ),
    );
  };

  const handleAddCutout = async (kind: QuickCutoutKind) => {
    if (baseRevision === null) return;
    const objRec = asRecord(sceneObj);
    const geomRec = asRecord(objRec?.geometry);
    const computedBounds = computeSceneGeometryBoundsMeters(geomRec);
    const boundsSource =
      computedBounds ??
      objRec?.bounds ??
      (geomRec?.bounds_min && geomRec?.bounds_max
        ? { max: geomRec.bounds_max, min: geomRec.bounds_min }
        : asRecord(geomRec?.geometry_params));
    const geometry = buildQuickCutoutGeometry(kind, boundsSource);
    const label = `${kind} cutout ${parsed.operands.length}`;
    const existingIds = new Set(parsed.operands.map((op) => op.operandId));

    const response = await commitOperandUpdate(`Add ${kind} cutout to ${objectId}`, (rev) =>
      updateBooleanOperandsTransaction(
        kernel.api,
        {
          add_operand: {
            geometry,
            label,
          },
          base_revision: rev,
          object_id: objectId,
        },
        requestOptions,
      ),
    );

    const updatedObj = response?.committed_scene?.objects?.find((item) => item.id === objectId);
    const nextOperands = parseCompositeGeometry(updatedObj?.geometry).operands;
    const addedOperand = nextOperands.find((op) => !existingIds.has(op.operandId));
    if (addedOperand) {
      setExpandedOperandId(addedOperand.operandId);
      setAutoFocusOperandId(addedOperand.operandId);
    }
  };

  const handleInspectOperand = (operand: NormalizedGeometryOperand) => {
    const nodeId = `model:object:${objectId}:geometry:${operand.operandId}`;
    kernel.selection.set(
      {
        kind: "object.geometry.node",
        label: operand.label,
        nodeId,
        objectId,
        ref: {
          geometryNodeId: operand.operandId,
          kind: "object.geometry.node",
          nodeId,
          objectId,
          operandId: operand.operandId,
          type: "scene-object",
          visualizationTargetId: `object:${objectId}`,
        },
      },
      "inspector",
    );
  };

  const patches = inlineNodePatches ?? {};

  return (
    <div className="flex flex-col gap-3" data-slot="boolean-node-section">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--fm-text-secondary)]">
            <Combine aria-hidden="true" size={14} />
            <span>Boolean Operation</span>
          </div>
          {parsed.operands.length >= 2 ? (
            <Button
              disabled={busy || baseRevision === null}
              size="sm"
              type="button"
              variant="ghost"
              onClick={handleSwapBaseTool}
            >
              <ArrowUpDown aria-hidden="true" size={13} />
              <span>Swap Base \u2194 Tool</span>
            </Button>
          ) : null}
        </div>
        <SegmentedControl
          aria-label="Boolean operation"
          columns={4}
          disabled={busy || baseRevision === null}
          options={BOOLEAN_OP_OPTIONS}
          value={currentOp}
          onValueChange={handleChangeOp}
        />
      </div>

      <div className="flex flex-col gap-1.5" role="list" aria-label="Boolean CSG operands">
        {parsed.operands.map((operand, index) => {
          const ghostVisible = ghostKeys.has(
            geometryOperandGhostKey(objectId, operand.operandId),
          );
          const operandPatch = patches[operand.operandId];
          const effectiveEnabled = operandPatch?.enabled ?? operand.enabled;
          const isExpanded = expandedOperandId === operand.operandId;
          const subtitle = summarizeOperandSubtitle(operand, operandPatch);
          const canExpandInline = Boolean(onPatchNode);

          return (
            <div
              key={operand.operandId}
              className="flex flex-col rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-surface-subtle)] px-2.5 py-2"
              data-expanded={isExpanded ? "true" : "false"}
              data-operand-id={operand.operandId}
              role="listitem"
            >
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <Switch
                    aria-label={`Toggle ${operand.label}`}
                    checked={effectiveEnabled}
                    disabled={busy || baseRevision === null}
                    onCheckedChange={(checked) =>
                      handleToggleOperand(operand, Boolean(checked))
                    }
                  />
                  <Button
                    aria-expanded={canExpandInline ? isExpanded : undefined}
                    className="min-w-0 flex-1 justify-start gap-1.5 px-1.5 text-left"
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      if (canExpandInline) {
                        setAutoFocusOperandId(null);
                        setExpandedOperandId((current) =>
                          current === operand.operandId ? null : operand.operandId,
                        );
                      } else {
                        handleInspectOperand(operand);
                      }
                    }}
                  >
                    {canExpandInline ? (
                      isExpanded ? (
                        <ChevronDown aria-hidden="true" className="shrink-0" size={13} />
                      ) : (
                        <ChevronRight aria-hidden="true" className="shrink-0" size={13} />
                      )
                    ) : null}
                    <Badge variant={operand.role === "base" ? "accent" : "secondary"}>
                      {operand.roleBadge}
                    </Badge>
                    <span className="truncate text-xs font-medium text-[var(--fm-text-primary)]">
                      {operand.label}
                    </span>
                    {subtitle ? (
                      <span className="hidden truncate font-mono text-xs text-[var(--fm-text-muted)] sm:inline">
                        {subtitle}
                      </span>
                    ) : null}
                  </Button>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    aria-label={`Toggle ghost wireframe for ${operand.label}`}
                    aria-pressed={ghostVisible}
                    className={cn(
                      ghostVisible &&
                        "border border-[var(--fm-accent)] bg-[var(--fm-surface-1)] text-[var(--fm-text-primary)]",
                    )}
                    data-active={ghostVisible ? "true" : undefined}
                    size="icon"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      geometryGhostVisibilityStore.toggle(objectId, operand.operandId)
                    }
                  >
                    {ghostVisible ? (
                      <Eye aria-hidden="true" size={13} />
                    ) : (
                      <EyeOff aria-hidden="true" size={13} />
                    )}
                  </Button>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label={`Actions for ${operand.label}`}
                        disabled={busy || baseRevision === null}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <MoreVertical aria-hidden="true" size={13} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => handleInspectOperand(operand)}>
                        <ExternalLink aria-hidden="true" size={13} />
                        <span>Open in Node Inspector</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={busy || index === 0 || baseRevision === null}
                        onSelect={() => handleMoveOperand(index, -1)}
                      >
                        <ArrowUp aria-hidden="true" size={13} />
                        <span>Move Up</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={
                          busy || index === parsed.operands.length - 1 || baseRevision === null
                        }
                        onSelect={() => handleMoveOperand(index, 1)}
                      >
                        <ArrowDown aria-hidden="true" size={13} />
                        <span>Move Down</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={busy || baseRevision === null}
                        onSelect={() => handleArrayOperand(operand)}
                      >
                        <Grid3X3 aria-hidden="true" size={13} />
                        <span>Apply Array 3D</span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={busy || baseRevision === null}
                        onSelect={() => handleExtractOperand(operand)}
                      >
                        <Scissors aria-hidden="true" size={13} />
                        <span>Extract as Object</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-[var(--fm-danger)]"
                        disabled={
                          busy || parsed.operands.length <= 1 || baseRevision === null
                        }
                        onSelect={() => handleRemoveOperand(operand)}
                      >
                        <Trash2 aria-hidden="true" size={13} />
                        <span>Remove Operand</span>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {canExpandInline && isExpanded && onPatchNode ? (
                <InlineNodeFields
                  autoFocusPrimaryField={autoFocusOperandId === operand.operandId}
                  disabled={busy}
                  nodePath={operand.operandId}
                  parentBaseThicknessM={operand.role === "base" ? null : baseThicknessM}
                  patches={patches}
                  rootGeometry={sceneObj.geometry}
                  sceneObj={sceneObj}
                  unit={unit}
                  onPatchNode={onPatchNode}
                  onUnitChange={handleUnitChange}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--fm-border-subtle)] pt-2">
        <span className="text-xs text-[var(--fm-text-muted)]">Add cutout (1.2 &times; Lz):</span>
        {(["Cylinder", "Box", "Sphere"] as const).map((kind) => (
          <Button
            key={kind}
            disabled={busy || baseRevision === null}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => {
              void handleAddCutout(kind);
            }}
          >
            <Plus aria-hidden="true" size={12} />
            <span>{kind}</span>
          </Button>
        ))}
      </div>

      {errorMessage ? (
        <p className="text-xs text-[var(--fm-danger)]" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
