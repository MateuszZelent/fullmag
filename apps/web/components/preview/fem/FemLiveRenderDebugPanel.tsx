"use client";

import { useMemo } from "react";

type FemFieldDataLike = {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
};

export interface FemLiveRenderDebugData {
  backendLabel: string;
  viewMode: string;
  fieldLabel: string;
  viewportLabel: string;
  transportLabel: string;
  solverStep: number | string | null;
  bufferSourceStep: number | string | null;
  liveFieldSourceStep: number | string | null;
  previewSourceStep: number | string | null;
  fieldData: FemFieldDataLike | null | undefined;
  fieldRevision: number | string | null | undefined;
  fieldDataTimestamp: number | null | undefined;
}

function formatScalar(value: number | string | null | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (value == null || !Number.isFinite(value)) {
    return "-";
  }
  const abs = Math.abs(value);
  if (abs >= 1_000 || (abs > 0 && abs < 1e-3)) {
    return value.toExponential(3);
  }
  return value.toFixed(6);
}

function formatVector(value: readonly [number, number, number] | null | undefined): string {
  if (!value) {
    return "-";
  }
  return `[${formatScalar(value[0])}, ${formatScalar(value[1])}, ${formatScalar(value[2])}]`;
}

function formatTimestamp(timestamp: number | null | undefined): string {
  if (timestamp == null || !Number.isFinite(timestamp)) {
    return "-";
  }
  return new Date(timestamp).toLocaleTimeString("pl-PL", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function countVectors(fieldData: FemFieldDataLike | null | undefined): number {
  if (!fieldData) {
    return 0;
  }
  return Math.min(fieldData.x?.length ?? 0, fieldData.y?.length ?? 0, fieldData.z?.length ?? 0);
}

function averageFieldComponents(
  fieldData: FemFieldDataLike | null | undefined,
): [number, number, number] | null {
  const vectorCount = countVectors(fieldData);
  if (!fieldData || vectorCount <= 0) {
    return null;
  }
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (let index = 0; index < vectorCount; index += 1) {
    sumX += Number(fieldData.x[index] ?? 0);
    sumY += Number(fieldData.y[index] ?? 0);
    sumZ += Number(fieldData.z[index] ?? 0);
  }
  return [sumX / vectorCount, sumY / vectorCount, sumZ / vectorCount];
}

function sampleFieldRows(fieldData: FemFieldDataLike | null | undefined): string[] {
  const vectorCount = countVectors(fieldData);
  if (!fieldData || vectorCount <= 0) {
    return [];
  }
  const sampleIndices =
    vectorCount <= 8
      ? Array.from({ length: vectorCount }, (_, index) => index)
      : [
          0,
          1,
          2,
          Math.floor(vectorCount / 4),
          Math.floor(vectorCount / 2),
          Math.floor((3 * vectorCount) / 4),
          vectorCount - 2,
          vectorCount - 1,
        ];
  const unique = Array.from(
    new Set(sampleIndices.filter((index) => index >= 0 && index < vectorCount)),
  ).sort((lhs, rhs) => lhs - rhs);
  const width = String(Math.max(vectorCount - 1, 0)).length;

  return unique.map(
    (index) =>
      `${String(index).padStart(width, "0")} | [${formatScalar(Number(fieldData.x[index] ?? 0))}, ${formatScalar(Number(fieldData.y[index] ?? 0))}, ${formatScalar(Number(fieldData.z[index] ?? 0))}]`,
  );
}

export function FemLiveRenderDebugPanel({
  debugData,
}: {
  debugData: FemLiveRenderDebugData;
}) {
  const renderedVectorCount = useMemo(
    () => countVectors(debugData.fieldData),
    [debugData.fieldData],
  );
  const renderedVectorAverage = useMemo(
    () => averageFieldComponents(debugData.fieldData),
    [debugData.fieldData],
  );
  const renderedVectorSample = useMemo(
    () => sampleFieldRows(debugData.fieldData),
    [debugData.fieldData],
  );

  return (
    <div className="space-y-3 text-[0.68rem]">
      <div className="rounded-md border border-emerald-400/18 bg-emerald-400/6 px-3 py-2 text-[0.64rem] leading-5 text-muted-foreground">
        Inspect the active FEM render buffer currently handed to the viewport.
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-border/30 bg-background/35 px-3 py-3">
        <span className="text-muted-foreground">Backend</span>
        <span className="font-mono text-right text-foreground">{debugData.backendLabel}</span>
        <span className="text-muted-foreground">View mode</span>
        <span className="font-mono text-right text-foreground">{debugData.viewMode}</span>
        <span className="text-muted-foreground">Field</span>
        <span className="font-mono text-right text-foreground">{debugData.fieldLabel}</span>
        <span className="text-muted-foreground">Viewport</span>
        <span className="font-mono text-right text-foreground">{debugData.viewportLabel}</span>
        <span className="text-muted-foreground">Transport</span>
        <span className="font-mono text-right text-foreground">{debugData.transportLabel}</span>
        <span className="text-muted-foreground">Solver step</span>
        <span className="font-mono text-right text-foreground">{formatScalar(debugData.solverStep)}</span>
        <span className="text-muted-foreground">Buffer source step</span>
        <span className="font-mono text-right text-foreground">{formatScalar(debugData.bufferSourceStep)}</span>
        <span className="text-muted-foreground">Live field step</span>
        <span className="font-mono text-right text-foreground">{formatScalar(debugData.liveFieldSourceStep)}</span>
        <span className="text-muted-foreground">Preview step</span>
        <span className="font-mono text-right text-foreground">{formatScalar(debugData.previewSourceStep)}</span>
        <span className="text-muted-foreground">Vectors</span>
        <span className="font-mono text-right text-foreground">{renderedVectorCount.toLocaleString()}</span>
        <span className="text-muted-foreground">Mean [mx,my,mz]</span>
        <span className="font-mono text-right text-foreground">{formatVector(renderedVectorAverage)}</span>
        <span className="text-muted-foreground">FieldData</span>
        <span className="font-mono text-right text-foreground">{debugData.fieldData ? "yes" : "no"}</span>
        <span className="text-muted-foreground">Revision</span>
        <span className="font-mono text-right text-foreground">{formatScalar(debugData.fieldRevision)}</span>
        <span className="text-muted-foreground">Updated</span>
        <span className="font-mono text-right text-foreground">{formatTimestamp(debugData.fieldDataTimestamp)}</span>
      </div>

      <div className="rounded-md border border-border/30 bg-background/35 px-3 py-3">
        <div className="mb-2 text-[0.6rem] font-bold uppercase tracking-[0.16em] text-muted-foreground">
          Rendered Buffer Sample
        </div>
        <pre className="max-h-72 overflow-auto rounded-lg border border-white/8 bg-black/30 px-3 py-2 text-[0.66rem] leading-5 text-emerald-100">
{renderedVectorSample.length > 0
  ? renderedVectorSample.join("\n")
  : "No FEM fieldData was handed to the renderer."}
        </pre>
      </div>
    </div>
  );
}
