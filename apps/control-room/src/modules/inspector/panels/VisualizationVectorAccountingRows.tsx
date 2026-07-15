"use client";

import { useEffect } from "react";

import type { VisualizationTargetKind } from "@/kernel/visualization/ObjectVisualizationController";
import {
  useVisualizationDebugController,
  useVisualizationDebugSnapshots,
} from "@/kernel/visualization/useVisualizationDebug";

import { FieldRow } from "../primitives/FieldRow";
import { formatCount } from "./MeshResourceView";
import {
  resolveVisualizationVectorAccounting,
  type VisualizationVectorAccounting,
} from "./ObjectVisualizationPanelModel";

interface VisualizationVectorAccountingRowsProps {
  availableNodeCount: number;
  currentTopologyHash?: string | null;
  exact: boolean;
  targetKind: VisualizationTargetKind;
}

export function VisualizationVectorAccountingRows(
  props: VisualizationVectorAccountingRowsProps,
) {
  if (props.targetKind === "airbox") {
    return <AirboxVectorAccountingRows {...props} />;
  }
  return (
    <VectorAccountingRows
      accounting={resolveVisualizationVectorAccounting({
        availableNodeCount: props.exact ? props.availableNodeCount : null,
        currentTopologyHash: props.currentTopologyHash,
        snapshots: [],
      })}
      {...props}
    />
  );
}

function AirboxVectorAccountingRows(
  props: VisualizationVectorAccountingRowsProps,
) {
  const controller = useVisualizationDebugController();
  const snapshots = useVisualizationDebugSnapshots("airbox");
  useEffect(() => controller.request("airbox"), [controller]);
  return (
    <VectorAccountingRows
      accounting={resolveVisualizationVectorAccounting({
        availableNodeCount: props.exact ? props.availableNodeCount : null,
        currentTopologyHash: props.currentTopologyHash,
        snapshots,
      })}
      {...props}
    />
  );
}

function VectorAccountingRows({
  accounting,
  availableNodeCount,
  exact,
  targetKind,
}: VisualizationVectorAccountingRowsProps & {
  accounting: VisualizationVectorAccounting;
}) {
  return (
    <>
      <FieldRow
        label={
          targetKind === "airbox"
            ? "Available air-only nodes"
            : "Available nodes"
        }
        value={
          targetKind === "airbox" && !exact
            ? "waiting"
            : `${formatCount(availableNodeCount)}${exact ? "" : " est."}`
        }
      />
      <FieldRow
        label="Decoded field samples"
        value={
          accounting.decodedSampleCount === null
            ? "waiting"
            : formatCount(accounting.decodedSampleCount)
        }
      />
      <FieldRow
        label="Adopted arrows"
        value={
          accounting.adoptedGlyphCount === null
            ? "waiting"
            : formatCount(accounting.adoptedGlyphCount)
        }
      />
    </>
  );
}
