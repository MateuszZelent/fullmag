"use client";

import type { VisualizationTargetKind } from "@/kernel/visualization/ObjectVisualizationController";
import { useVisualizationDebugSnapshots } from "@/kernel/visualization/useVisualizationDebug";
import type { VisualizationVectorCapacityDescriptor } from "@/kernel/visualization/visualizationVectorCapacity";

import { FieldRow } from "../primitives/FieldRow";
import { formatCount } from "./MeshResourceView";
import {
  DEFAULT_VISUALIZATION_VECTOR_SCENE_CAP,
  resolveVisualizationVectorAccounting,
  type VisualizationVectorAccounting,
} from "./ObjectVisualizationPanelModel";

interface VisualizationVectorAccountingRowsProps {
  anchorKind?: "cell" | "node" | null;
  availableAnchorCount?: number | null;
  /** @deprecated Kept for the opt-in visualization debug panel contract. */
  availableNodeCount?: number;
  capacity?: VisualizationVectorCapacityDescriptor | null;
  currentComponent?: string | null;
  currentGeneration?: string | null;
  currentScopeId?: string | null;
  currentScopeKind?: string | null;
  currentTopologyHash?: string | null;
  exact: boolean;
  expectedGeneration?: string | null;
  expectedQuantityId?: string | null;
  expectedScopeId?: string | null;
  expectedScopeKind?: string | null;
  expectedVisualizationRevision?: string | number | null;
  effectiveAllocation?: number | null;
  requestedBudget?: number | null;
  sceneCap?: number | null;
  targetId?: string;
  targetKind: VisualizationTargetKind;
}

export function VisualizationVectorAccountingRows(
  props: VisualizationVectorAccountingRowsProps,
) {
  // Reading already-published snapshots is passive. The explicit Debug panel
  // owns demand leases and value-statistics scans.
  const snapshots = useVisualizationDebugSnapshots(
    props.targetId ?? props.targetKind,
  );
  const accounting = resolveVisualizationVectorAccounting({
    anchorKind: props.anchorKind,
    availableAnchorCount: props.exact
      ? props.availableAnchorCount ?? props.availableNodeCount ?? null
      : props.availableAnchorCount ?? props.availableNodeCount ?? null,
    availableNodeCount:
      props.requestedBudget === undefined && props.capacity === undefined
        ? props.exact
          ? props.availableNodeCount ?? null
          : null
        : undefined,
    capacity: props.capacity,
    currentComponent: props.currentComponent,
    currentGeneration: props.currentGeneration,
    currentScopeId: props.currentScopeId,
    currentScopeKind: props.currentScopeKind,
    currentTargetId: props.targetId,
    currentTopologyHash: props.currentTopologyHash,
    expectedGeneration: props.expectedGeneration,
    expectedQuantityId: props.expectedQuantityId,
    expectedScopeId: props.expectedScopeId,
    expectedScopeKind: props.expectedScopeKind,
    expectedVisualizationRevision: props.expectedVisualizationRevision,
    effectiveAllocation: props.effectiveAllocation,
    requestedBudget: props.requestedBudget,
    snapshots,
  });
  return (
    <VectorAccountingRows
      accounting={accounting}
      anchorKind={props.anchorKind}
      availableAnchorCount={
        props.availableAnchorCount ?? props.availableNodeCount ?? null
      }
      exact={props.exact}
      sceneCap={props.sceneCap}
      targetKind={props.targetKind}
    />
  );
}

function VectorAccountingRows({
  accounting,
  anchorKind,
  availableAnchorCount,
  exact,
  sceneCap,
  targetKind,
}: VisualizationVectorAccountingRowsProps & {
  accounting: VisualizationVectorAccounting;
}) {
  const resolvedAnchorKind = accounting.anchorKind ?? anchorKind;
  const anchorUnit = resolvedAnchorKind === "node" ? "nodes" : "cells";
  const availableValue =
    accounting.availableAnchorCount ?? availableAnchorCount;
  const status = accounting.status ?? "unavailable";
  return (
    <>
      <FieldRow
        label="Available vector anchors"
        value={
          availableValue === null || availableValue === undefined
            ? "unavailable"
            : `${formatCount(availableValue)} ${anchorUnit}${exact ? "" : " est."}`
        }
      />
      <FieldRow
        label="Requested budget"
        value={formatAccountingValue(accounting.requestedBudget, status)}
      />
      <FieldRow
        label="Effective scene allocation"
        value={formatAccountingValue(accounting.allocatedBudget, status)}
      />
      <FieldRow
        label="Scene policy cap"
        unit="arrows"
        value={formatCount(sceneCap ?? DEFAULT_VISUALIZATION_VECTOR_SCENE_CAP)}
      />
      <FieldRow
        label="Decoded field samples"
        value={formatAccountingValue(accounting.decodedSampleCount, status)}
      />
      <FieldRow
        label="Adopted arrows"
        value={formatAccountingValue(accounting.adoptedGlyphCount, status)}
      />
      {targetKind !== "airbox" && status === "unavailable" ? (
        <span className="sr-only">Vector accounting is not reported for this target.</span>
      ) : null}
    </>
  );
}

function formatAccountingValue(
  value: number | null | undefined,
  status: VisualizationVectorAccounting["status"],
): string {
  if (value !== null && value !== undefined) return formatCount(value);
  if (status === "pending") return "pending";
  if (status === "stale") return "stale";
  return "not reported";
}
