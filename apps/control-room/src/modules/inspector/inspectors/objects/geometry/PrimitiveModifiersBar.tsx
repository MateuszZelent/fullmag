"use client";

import { ChevronDown, Combine, Grid3X3, MinusCircle } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { defaultArray3DAxes } from "@/kernel/authoring/array3dModel";
import {
  booleanCombineObjectsTransaction,
  patchObjectGeometryTransaction,
  type BooleanCombineOp,
} from "@/kernel/authoring/geometryLifecycleCommands";
import type { KernelApi } from "@/kernel/types";
import { computeSceneGeometryBoundsMeters } from "@/shared/domain/geometry/sceneGeometryBounds";
import { Button } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";

import {
  Array3DLatticeTableSection,
  resolveArray3DChildBoundsMeters,
  type DisplayLengthUnit,
} from "./Array3DLatticeTableSection";
import { buildQuickCutoutGeometry } from "./BooleanNodeSection";
import { commitGeometryStackTransaction } from "./geometryHistoryRunner";
import { serializeGeometryPayload } from "./geometrySerialization";
import type { Array3DDraftConfig, ObjectGeometrySpecDraft } from "./geometryShared";

const COMBINE_OPS: readonly { label: string; op: BooleanCombineOp }[] = [
  { label: "Union (A \u222a B)", op: "union" },
  { label: "Subtract (A \u2212 B)", op: "subtract" },
  { label: "Intersect (A \u2229 B)", op: "intersect" },
  { label: "XOR (A \u2295 B)", op: "xor" },
];

export interface PrimitiveModifiersBarProps {
  kernel: KernelApi;
  draft: ObjectGeometrySpecDraft;
  sceneData: SceneResource | null | undefined;
  sessionScopeKey: string | null;
  otherObjects: readonly { value: string; label: string }[];
  hasDirtyDraft: boolean;
  onFlushDraft: () => Promise<boolean>;
  onArray3DChange: (next: Array3DDraftConfig | null) => void;
  onCutHoleCreated: (holeOperandId: string) => void;
  unit: DisplayLengthUnit;
  onUnitChange: (unit: DisplayLengthUnit) => void;
  disabled?: boolean;
}

/**
 * Compact Modifiers & Boolean Tools bar shown directly beneath primitive dimensions
 * on the Geometry tab: 1-click Cut Hole, staged Array 3D, and Combine with…
 */
export function PrimitiveModifiersBar({
  kernel,
  draft,
  sceneData,
  sessionScopeKey,
  otherObjects,
  hasDirtyDraft,
  onFlushDraft,
  onArray3DChange,
  onCutHoleCreated,
  unit,
  onUnitChange,
  disabled = false,
}: PrimitiveModifiersBarProps) {
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sceneObj = useMemo(
    () => sceneData?.objects?.find((item) => item.id === draft.objectId) ?? null,
    [draft.objectId, sceneData?.objects],
  );
  const baseRevision =
    typeof sceneData?.revision === "number" && Number.isFinite(sceneData.revision)
      ? sceneData.revision
      : null;

  const childBounds = useMemo(
    () => resolveArray3DChildBoundsMeters(sceneObj, serializeGeometryPayload({ ...draft, array3dConfig: null })),
    [draft, sceneObj],
  );

  const requestOptions = useMemo(
    () => (sessionScopeKey ? { sessionScopeKey } : undefined),
    [sessionScopeKey],
  );

  const handleCutHole = useCallback(async () => {
    if (busy || disabled || baseRevision === null || draft.mode !== "committed") return;
    setBusy(true);
    setErrorMessage(null);
    try {
      const baseGeom = serializeGeometryPayload({ ...draft, array3dConfig: null });
      const sceneObjRecord =
        sceneObj && typeof sceneObj === "object"
          ? (sceneObj as Record<string, unknown>)
          : null;
      const baseBounds =
        computeSceneGeometryBoundsMeters(baseGeom) ??
        (sceneObjRecord?.bounds ?? null);
      const holeGeom = buildQuickCutoutGeometry("Cylinder", baseBounds);
      const holeOperandId = `op_hole_${Date.now().toString(36)}`;
      const nextGeometry: JsonObject = {
        geometry_kind: "Difference",
        geometry_params: {
          operands: [
            {
              enabled: true,
              geometry: baseGeom,
              label: draft.draftName || "Base",
              operand_id: "op_base",
            },
            {
              enabled: true,
              geometry: holeGeom,
              label: "Hole",
              operand_id: holeOperandId,
            },
          ],
        },
      };

      await commitGeometryStackTransaction({
        kernel,
        label: `Cut hole in ${draft.draftName}`,
        sceneData,
        sessionScopeKey,
        execute: ({ baseRevision: rev }) =>
          patchObjectGeometryTransaction(
            kernel.api,
            draft.objectId,
            {
              base_revision: rev ?? baseRevision,
              geometry: nextGeometry,
            },
            requestOptions,
          ),
      });
      onCutHoleCreated(holeOperandId);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not cut hole in object.",
      );
    } finally {
      setBusy(false);
    }
  }, [
    baseRevision,
    busy,
    disabled,
    draft,
    kernel,
    onCutHoleCreated,
    requestOptions,
    sceneData,
    sceneObj,
    sessionScopeKey,
  ]);

  const handleCombineWith = useCallback(
    async (op: BooleanCombineOp, toolObjectId: string, toolLabel: string) => {
      if (busy || disabled || baseRevision === null || draft.mode !== "committed") return;
      setBusy(true);
      setErrorMessage(null);
      try {
        if (hasDirtyDraft) {
          const flushed = await onFlushDraft();
          if (!flushed) return;
        }
        await commitGeometryStackTransaction({
          kernel,
          label: `${op} ${draft.draftName} with ${toolLabel}`,
          sceneData,
          sessionScopeKey,
          execute: ({ baseRevision: rev }) =>
            booleanCombineObjectsTransaction(
              kernel.api,
              {
                base_revision: rev ?? baseRevision,
                keep_tools: false,
                op,
                target_object_id: draft.objectId,
                tool_object_ids: [toolObjectId],
              },
              requestOptions,
            ),
        });
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : "Could not combine objects.",
        );
      } finally {
        setBusy(false);
      }
    },
    [
      baseRevision,
      busy,
      disabled,
      draft.draftName,
      draft.mode,
      draft.objectId,
      hasDirtyDraft,
      kernel,
      onFlushDraft,
      requestOptions,
      sceneData,
      sessionScopeKey,
    ],
  );

  const actionsDisabled = busy || disabled || baseRevision === null;

  return (
    <div className="flex flex-col gap-3" data-slot="primitive-modifiers-bar">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          className="whitespace-nowrap"
          disabled={actionsDisabled}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => {
            void handleCutHole();
          }}
        >
          <MinusCircle aria-hidden="true" size={13} />
          <span>Cut Hole</span>
        </Button>

        <Button
          className="whitespace-nowrap"
          disabled={actionsDisabled || draft.array3dConfig !== null}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            onArray3DChange({
              axes: defaultArray3DAxes(),
              mergeOverlapping: false,
              realization: "modifier_in_object",
            })
          }
        >
          <Grid3X3 aria-hidden="true" size={13} />
          <span>Array 3D</span>
        </Button>

        {otherObjects.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="whitespace-nowrap"
                disabled={actionsDisabled}
                size="sm"
                type="button"
                variant="secondary"
              >
                <Combine aria-hidden="true" size={13} />
                <span>Combine with…</span>
                <ChevronDown aria-hidden="true" size={12} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Boolean operation with object</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {COMBINE_OPS.map((item) => (
                <DropdownMenuSub key={item.op}>
                  <DropdownMenuSubTrigger>{item.label}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {otherObjects.map((other) => (
                      <DropdownMenuItem
                        key={other.value}
                        onSelect={() => {
                          void handleCombineWith(item.op, other.value, other.label);
                        }}
                      >
                        {other.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <p className="text-xs text-[var(--fm-text-muted)]">
        Creates an editable non-destructive Geometry Stack with full Undo support.
      </p>

      {draft.array3dConfig ? (
        <div
          className="flex flex-col gap-2 rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-surface-subtle)] p-2.5"
          data-slot="staged-root-array3d"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--fm-text-secondary)]">
            <Grid3X3 aria-hidden="true" size={13} />
            <span>Array 3D Modifier (staged — apply in footer)</span>
          </div>
          <Array3DLatticeTableSection
            childBounds={childBounds}
            disabled={busy || disabled}
            unit={unit}
            value={draft.array3dConfig}
            onChange={(next) => onArray3DChange(next)}
            onRemoveModifier={() => onArray3DChange(null)}
            onUnitChange={onUnitChange}
          />
        </div>
      ) : null}

      {errorMessage ? (
        <p className="text-xs text-[var(--fm-danger)]" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
