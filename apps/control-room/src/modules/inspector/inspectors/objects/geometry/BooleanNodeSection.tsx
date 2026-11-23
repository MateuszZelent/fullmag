"use client";

import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Combine,
  Eye,
  EyeOff,
  Plus,
  Scissors,
  Trash2,
} from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import {
  separateObjectTransaction,
  updateBooleanOperandsTransaction,
  type BooleanOperandOp,
} from "@/kernel/authoring/geometryLifecycleCommands";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import type { KernelApi } from "@/kernel/types";
import {
  geometryGhostVisibilityStore,
  geometryOperandGhostKey,
} from "@/kernel/visualization/geometryGhostVisibilityStore";
import {
  parseCompositeGeometry,
  type NormalizedGeometryOperand,
} from "@/modules/explorer/builders/geometryTreeExplorerNodes";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";

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
): Record<string, unknown> {
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

export interface BooleanNodeSectionProps {
  kernel: KernelApi;
  objectId: string;
  sceneData: SceneResource | null | undefined;
  sessionScopeKey: string | null;
}

export function BooleanNodeSection({
  kernel,
  objectId,
  sceneData,
  sessionScopeKey,
}: BooleanNodeSectionProps) {
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const ghostKeys = useSyncExternalStore(
    geometryGhostVisibilityStore.subscribe,
    geometryGhostVisibilityStore.getSnapshot,
    geometryGhostVisibilityStore.getServerSnapshot,
  );

  const sceneObj = sceneData?.objects?.find((obj) => obj.id === objectId) ?? null;
  const parsed = parseCompositeGeometry(sceneObj?.geometry);
  const baseRevision =
    typeof sceneData?.revision === "number" && Number.isFinite(sceneData.revision)
      ? sceneData.revision
      : null;

  const commitOperandUpdate = useCallback(
    async (
      mutation: () => Promise<{ committed_scene?: SceneResource; scene_revision?: number }>,
    ) => {
      if (busy || baseRevision === null) return;
      setBusy(true);
      setErrorMessage(null);
      try {
        const response = await mutation();
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
          error instanceof Error ? error.message : "Could not update boolean operand stack.",
        );
      } finally {
        setBusy(false);
      }
    },
    [baseRevision, busy, kernel.api.resourceCacheScope, kernel.resources, sessionScopeKey],
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
    void commitOperandUpdate(() =>
      updateBooleanOperandsTransaction(
        kernel.api,
        { base_revision: baseRevision, object_id: objectId, op: nextOp },
        requestOptions,
      ),
    );
  };

  const handleToggleOperand = (operand: NormalizedGeometryOperand, enabled: boolean) => {
    if (baseRevision === null) return;
    void commitOperandUpdate(() =>
      updateBooleanOperandsTransaction(
        kernel.api,
        {
          base_revision: baseRevision,
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
    void commitOperandUpdate(() =>
      updateBooleanOperandsTransaction(
        kernel.api,
        {
          base_revision: baseRevision,
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
    void commitOperandUpdate(() =>
      updateBooleanOperandsTransaction(
        kernel.api,
        {
          base_revision: baseRevision,
          object_id: objectId,
          reorder_operand_ids: nextIds,
        },
        requestOptions,
      ),
    );
  };

  const handleRemoveOperand = (operandId: string) => {
    if (baseRevision === null || parsed.operands.length <= 1) return;
    void commitOperandUpdate(() =>
      updateBooleanOperandsTransaction(
        kernel.api,
        {
          base_revision: baseRevision,
          object_id: objectId,
          remove_operand_id: operandId,
        },
        requestOptions,
      ),
    );
  };

  const handleExtractOperand = (operandId: string) => {
    if (baseRevision === null) return;
    void commitOperandUpdate(() =>
      separateObjectTransaction(
        kernel.api,
        {
          base_revision: baseRevision,
          keep_in_boolean: false,
          mode: "extract_operand",
          object_id: objectId,
          operand_id: operandId,
        },
        requestOptions,
      ),
    );
  };

  const handleAddCutout = (kind: QuickCutoutKind) => {
    if (baseRevision === null) return;
    const geometry = buildQuickCutoutGeometry(kind, sceneObj.bounds);
    const label = `${kind} cutout ${parsed.operands.length}`;
    void commitOperandUpdate(() =>
      updateBooleanOperandsTransaction(
        kernel.api,
        {
          add_operand: {
            geometry,
            label,
          },
          base_revision: baseRevision,
          object_id: objectId,
        },
        requestOptions,
      ),
    );
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

  return (
    <div className="flex flex-col gap-3" data-slot="boolean-node-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--fm-text-secondary)]">
          <Combine size={14} />
          <span>Boolean Operation</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {BOOLEAN_OP_OPTIONS.map((option) => (
            <Button
              key={option.value}
              disabled={busy || baseRevision === null}
              size="sm"
              type="button"
              variant={currentOp === option.value ? "primary" : "secondary"}
              onClick={() => handleChangeOp(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {parsed.operands.length >= 2 ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--fm-text-muted)]">
            Base [A] is index 0; tools [B1..Bk] follow in stack order.
          </span>
          <Button
            disabled={busy || baseRevision === null}
            size="sm"
            type="button"
            variant="ghost"
            onClick={handleSwapBaseTool}
          >
            <ArrowUpDown size={13} />
            <span>Swap Base ↔ Tool</span>
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5" role="list" aria-label="Boolean CSG operands">
        {parsed.operands.map((operand, index) => {
          const ghostVisible = ghostKeys.has(
            geometryOperandGhostKey(objectId, operand.operandId),
          );
          return (
            <div
              key={operand.operandId}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-surface-subtle)] px-2.5 py-2"
              data-operand-id={operand.operandId}
              role="listitem"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Switch
                  aria-label={`Toggle ${operand.label}`}
                  checked={operand.enabled}
                  disabled={busy || baseRevision === null}
                  onCheckedChange={(checked) =>
                    handleToggleOperand(operand, Boolean(checked))
                  }
                />
                <Badge variant={operand.role === "base" ? "accent" : "secondary"}>
                  {operand.roleBadge}
                </Badge>
                <Button
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => handleInspectOperand(operand)}
                >
                  <span className="truncate text-xs font-medium">{operand.label}</span>
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  aria-label={`Toggle ghost wireframe for ${operand.label}`}
                  size="sm"
                  type="button"
                  variant={ghostVisible ? "primary" : "ghost"}
                  onClick={() =>
                    geometryGhostVisibilityStore.toggle(objectId, operand.operandId)
                  }
                >
                  {ghostVisible ? <Eye size={13} /> : <EyeOff size={13} />}
                </Button>
                <Button
                  aria-label={`Move ${operand.label} up`}
                  disabled={busy || index === 0 || baseRevision === null}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => handleMoveOperand(index, -1)}
                >
                  <ArrowUp size={13} />
                </Button>
                <Button
                  aria-label={`Move ${operand.label} down`}
                  disabled={
                    busy || index === parsed.operands.length - 1 || baseRevision === null
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => handleMoveOperand(index, 1)}
                >
                  <ArrowDown size={13} />
                </Button>
                <Button
                  aria-label={`Extract ${operand.label}`}
                  disabled={busy || baseRevision === null}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => handleExtractOperand(operand.operandId)}
                >
                  <Scissors size={13} />
                </Button>
                <Button
                  aria-label={`Remove ${operand.label}`}
                  disabled={busy || parsed.operands.length <= 1 || baseRevision === null}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => handleRemoveOperand(operand.operandId)}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--fm-border-subtle)] pt-2">
        <span className="text-xs text-[var(--fm-text-muted)]">Add cutout (1.2 × Lz):</span>
        {(["Cylinder", "Box", "Sphere"] as const).map((kind) => (
          <Button
            key={kind}
            disabled={busy || baseRevision === null}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => handleAddCutout(kind)}
          >
            <Plus size={12} />
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
