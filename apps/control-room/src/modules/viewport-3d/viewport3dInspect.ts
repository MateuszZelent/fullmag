import type { DecodedFieldVector } from "@/kernel/api/codecs";

import type { FdmCuboidInstanceModel } from "./layers/FdmCuboidLayer";

interface Viewport3DInspectComponent {
  label: string;
  value: number;
}

export interface Viewport3DInspectScreenPosition {
  x: number;
  y: number;
}

interface Viewport3DInspectReadySample {
  components: Viewport3DInspectComponent[];
  pointIndex: number;
  quantityId: string;
  status: "ready";
  targetLabel: string;
  unit: string | null;
  worldPosition: [number, number, number];
}

interface Viewport3DInspectUnavailableSample {
  message: string;
  quantityId: string;
  status: "unavailable";
  targetLabel: string;
  worldPosition: [number, number, number];
}

export type Viewport3DInspectSample =
  | Viewport3DInspectReadySample
  | Viewport3DInspectUnavailableSample;

export interface Viewport3DFdmInspectSampleInput {
  fieldVector: DecodedFieldVector | null | undefined;
  instanceId: number | null | undefined;
  model: FdmCuboidInstanceModel | null | undefined;
  quantityId: string;
  worldPosition: [number, number, number];
}

export function buildViewport3DFdmInspectSample({
  fieldVector,
  instanceId,
  model,
  quantityId,
  worldPosition,
}: Viewport3DFdmInspectSampleInput): Viewport3DInspectSample {
  const safeInstanceId =
    typeof instanceId === "number" && Number.isInteger(instanceId)
      ? instanceId
      : -1;
  const pointIndex =
    model && safeInstanceId >= 0 && safeInstanceId < model.count
      ? model.cellIndices[safeInstanceId]
      : undefined;
  const targetLabel =
    typeof pointIndex === "number" ? `Cell ${pointIndex}` : "FDM cell";

  if (
    !fieldVector ||
    typeof pointIndex !== "number" ||
    pointIndex < 0 ||
    pointIndex >= fieldVector.pointCount
  ) {
    return {
      message: "Field sample is not loaded for this cell.",
      quantityId,
      status: "unavailable",
      targetLabel,
      worldPosition,
    };
  }

  return {
    components: resolveViewport3DInspectComponents(
      fieldVector,
      pointIndex,
      quantityId,
    ),
    pointIndex,
    quantityId,
    status: "ready",
    targetLabel,
    unit: unitForInspectQuantity(quantityId),
    worldPosition,
  };
}

export function formatViewport3DInspectComponents(
  sample: Viewport3DInspectSample,
): string[] {
  if (sample.status !== "ready") return [];
  return sample.components.map((component) =>
    [component.label, formatInspectNumber(component.value), sample.unit]
      .filter(Boolean)
      .join(" "),
  );
}

function resolveViewport3DInspectComponents(
  fieldVector: DecodedFieldVector,
  pointIndex: number,
  quantityId: string,
): Viewport3DInspectComponent[] {
  const offset = pointIndex * fieldVector.nComp;
  if (fieldVector.nComp <= 1) {
    return [
      {
        label: quantityId,
        value: finiteFieldValue(fieldVector.values[offset]),
      },
    ];
  }

  const x = finiteFieldValue(fieldVector.values[offset]);
  const y = finiteFieldValue(fieldVector.values[offset + 1]);
  const z = finiteFieldValue(fieldVector.values[offset + 2]);
  const prefix = componentPrefixForInspectQuantity(quantityId);
  return [
    { label: `${prefix}x`, value: x },
    { label: `${prefix}y`, value: y },
    { label: `${prefix}z`, value: z },
    { label: `|${prefix}|`, value: Math.hypot(x, y, z) },
  ];
}

function componentPrefixForInspectQuantity(quantityId: string): string {
  if (quantityId === "m" || quantityId.startsWith("m_")) return "m";
  if (quantityId === "B" || quantityId.startsWith("B_")) return "B";
  if (quantityId === "H" || quantityId.startsWith("H_")) return "H";
  return quantityId;
}

function unitForInspectQuantity(quantityId: string): string | null {
  if (quantityId === "H" || quantityId.startsWith("H_")) return "A/m";
  if (quantityId === "B" || quantityId.startsWith("B_")) return "T";
  return null;
}

function finiteFieldValue(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatInspectNumber(value: number): string {
  return Number.isFinite(value) ? Number(value.toPrecision(5)).toString() : "n/a";
}
