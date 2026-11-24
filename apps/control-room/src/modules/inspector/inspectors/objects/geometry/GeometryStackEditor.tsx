"use client";

import { ChevronDown, ChevronRight, Combine, ExternalLink, Grid3X3, Layers } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import {
  defaultArray3DAxes,
  parseArray3DGeometry,
} from "@/kernel/authoring/array3dModel";
import {
  booleanCombineObjectsTransaction,
  type BooleanCombineOp,
} from "@/kernel/authoring/geometryLifecycleCommands";
import type { KernelApi } from "@/kernel/types";
import { parseCompositeGeometry } from "@/kernel/authoring/compositeGeometryModel";
import { Badge } from "@/shared/ui/Badge";
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
import { BooleanNodeSection } from "./BooleanNodeSection";
import { commitGeometryStackTransaction } from "./geometryHistoryRunner";
import { buildGeometryNodeSelection } from "./GeometryNodeInspectorSpec";
import { formatGeometryUnitSummary } from "./geometryNodeTreeOps";
import type {
  Array3DDraftConfig,
  InlineOperandEditPatch,
  ObjectGeometrySpecDraft,
} from "./geometryShared";
import { InlineNodeFields } from "./InlineNodeFields";

const COMBINE_OPS: readonly { label: string; op: BooleanCombineOp }[] = [
  { label: "Union (A \u222a B)", op: "union" },
  { label: "Subtract (A \u2212 B)", op: "subtract" },
  { label: "Intersect (A \u2229 B)", op: "intersect" },
  { label: "XOR (A \u2295 B)", op: "xor" },
];

export interface GeometryStackEditorProps {
  kernel: KernelApi;
  draft: ObjectGeometrySpecDraft;
  sceneData: SceneResource | null | undefined;
  sessionScopeKey: string | null;
  otherObjects: readonly { value: string; label: string }[];
  hasDirtyDraft: boolean;
  onFlushDraft: () => Promise<boolean>;
  onPatchNode: (targetPath: string, patch: Partial<InlineOperandEditPatch>) => void;
  onArray3DChange: (next: Array3DDraftConfig | null) => void;
  initialExpandedOperandId: string | null;
  onExpandedOperandConsumed: () => void;
  unit: DisplayLengthUnit;
  onUnitChange: (unit: DisplayLengthUnit) => void;
  disabled?: boolean;
}

/**
 * Interactive Geometry Stack (3ds Max / Blender style inline accordion) for
 * composite CSG, Array3D, and SlicePlane objects. All parameter & lattice edits
 * stage into ObjectGeometrySpec's single footer CommitBar.
 */
export function GeometryStackEditor({
  kernel,
  draft,
  sceneData,
  sessionScopeKey,
  otherObjects,
  hasDirtyDraft,
  onFlushDraft,
  onPatchNode,
  onArray3DChange,
  initialExpandedOperandId,
  onExpandedOperandConsumed,
  unit,
  onUnitChange,
  disabled = false,
}: GeometryStackEditorProps) {
  const [unitExpanded, setUnitExpanded] = useState(true);
  const [combineBusy, setCombineBusy] = useState(false);
  const [combineError, setCombineError] = useState<string | null>(null);

  const sceneObj = useMemo(
    () => sceneData?.objects?.find((item) => item.id === draft.objectId) ?? null,
    [draft.objectId, sceneData?.objects],
  );
  const parsedComposite = useMemo(
    () => parseCompositeGeometry(sceneObj?.geometry),
    [sceneObj?.geometry],
  );
  const parsedRootArray = useMemo(
    () => parseArray3DGeometry(sceneObj?.geometry),
    [sceneObj?.geometry],
  );
  const rootChildBounds = useMemo(
    () => resolveArray3DChildBoundsMeters(sceneObj, sceneObj?.geometry),
    [sceneObj],
  );

  const baseRevision =
    typeof sceneData?.revision === "number" && Number.isFinite(sceneData.revision)
      ? sceneData.revision
      : null;

  const handleCombineWith = useCallback(
    async (op: BooleanCombineOp, toolObjectId: string, toolLabel: string) => {
      if (combineBusy || disabled || baseRevision === null) return;
      setCombineBusy(true);
      setCombineError(null);
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
              sessionScopeKey ? { sessionScopeKey } : undefined,
            ),
        });
      } catch (error) {
        setCombineError(
          error instanceof Error ? error.message : "Could not combine objects.",
        );
      } finally {
        setCombineBusy(false);
      }
    },
    [
      baseRevision,
      combineBusy,
      disabled,
      draft.draftName,
      draft.objectId,
      hasDirtyDraft,
      kernel,
      onFlushDraft,
      sceneData,
      sessionScopeKey,
    ],
  );

  if (!sceneObj || !draft.compositeSummary) {
    return null;
  }

  const isRootArray = draft.compositeSummary.op === "array";
  const isRootSlice = draft.compositeSummary.op === "slice";
  const isRootBoolean = !isRootArray && !isRootSlice && parsedComposite.operands.length > 0;

  return (
    <div className="flex flex-col gap-3" data-slot="geometry-stack-editor">
      {/* 1. Boolean Operand Stack with Inline Accordion */}
      {isRootBoolean ? (
        <BooleanNodeSection
          hasDirtyDraft={hasDirtyDraft}
          initialExpandedOperandId={initialExpandedOperandId}
          inlineNodePatches={draft.inlineNodePatches}
          kernel={kernel}
          objectId={draft.objectId}
          sceneData={sceneData}
          sessionScopeKey={sessionScopeKey}
          unit={unit}
          onExpandedOperandConsumed={onExpandedOperandConsumed}
          onFlushDraft={onFlushDraft}
          onPatchNode={onPatchNode}
          onUnitChange={onUnitChange}
        />
      ) : null}

      {/* 2. Root Array3D Base Unit (expandable inline) */}
      {isRootArray && parsedRootArray ? (
        <div
          className="flex flex-col rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-surface-subtle)] px-2.5 py-2"
          data-slot="array3d-root-unit-row"
        >
          <div className="flex items-center justify-between gap-2">
            <Button
              aria-expanded={unitExpanded}
              className="min-w-0 flex-1 justify-start gap-1.5 px-1 text-left"
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setUnitExpanded((prev) => !prev)}
            >
              {unitExpanded ? (
                <ChevronDown aria-hidden="true" className="shrink-0" size={13} />
              ) : (
                <ChevronRight aria-hidden="true" className="shrink-0" size={13} />
              )}
              <Badge variant="accent">Base Unit</Badge>
              <span className="truncate text-xs font-medium text-[var(--fm-text-primary)]">
                {formatGeometryUnitSummary(parsedRootArray.child) ?? "Unit Geometry"}
              </span>
            </Button>
            <Button
              aria-label="Open Base Unit in Node Inspector"
              size="icon"
              type="button"
              variant="ghost"
              onClick={() =>
                kernel.selection.set(
                  buildGeometryNodeSelection(draft.objectId, "array-child", "Base Unit"),
                  "inspector",
                )
              }
            >
              <ExternalLink aria-hidden="true" size={13} />
            </Button>
          </div>
          {unitExpanded ? (
            <InlineNodeFields
              disabled={disabled || combineBusy}
              nodePath="array-child"
              patches={draft.inlineNodePatches}
              rootGeometry={sceneObj.geometry}
              sceneObj={sceneObj}
              showArrayModifierEditor={false}
              unit={unit}
              onPatchNode={onPatchNode}
              onUnitChange={onUnitChange}
            />
          ) : null}
        </div>
      ) : null}

      {/* 3. Root SlicePlane Child (expandable inline) */}
      {isRootSlice ? (
        <div
          className="flex flex-col rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-surface-subtle)] px-2.5 py-2"
          data-slot="slice-root-child-row"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--fm-text-primary)]">
            <Layers aria-hidden="true" size={13} />
            <span>Sliced Source Geometry</span>
          </div>
          <InlineNodeFields
            disabled={disabled || combineBusy}
            nodePath="slice-child"
            patches={draft.inlineNodePatches}
            rootGeometry={sceneObj.geometry}
            sceneObj={sceneObj}
            showArrayModifierEditor={false}
            unit={unit}
            onPatchNode={onPatchNode}
            onUnitChange={onUnitChange}
          />
        </div>
      ) : null}

      {/* 4. Root Array 3D Modifier Table (Controlled — staged into footer CommitBar) */}
      {draft.array3dConfig ? (
        <div
          className="flex flex-col gap-2 rounded border border-[var(--fm-border-subtle)] bg-[var(--fm-surface-subtle)] p-2.5"
          data-slot="root-array3d-modifier"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium text-[var(--fm-text-secondary)]">
            <Grid3X3 aria-hidden="true" size={13} />
            <span>Array 3D Lattice Modifier</span>
          </div>
          <Array3DLatticeTableSection
            childBounds={rootChildBounds}
            disabled={disabled || combineBusy}
            unit={unit}
            value={draft.array3dConfig}
            onChange={(next) => onArray3DChange(next)}
            onRemoveModifier={() => onArray3DChange(null)}
            onUnitChange={onUnitChange}
          />
        </div>
      ) : null}

      {/* 5. Composite Stack Modifiers & Combine Bar */}
      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--fm-border-subtle)] pt-2">
        {!draft.array3dConfig ? (
          <Button
            className="whitespace-nowrap"
            disabled={disabled || combineBusy || baseRevision === null}
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
        ) : null}

        {otherObjects.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="whitespace-nowrap"
                disabled={disabled || combineBusy || baseRevision === null}
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

      {combineError ? (
        <p className="text-xs text-[var(--fm-danger)]" role="alert">
          {combineError}
        </p>
      ) : null}
    </div>
  );
}
