"use client";

import { useCallback, useMemo, useState } from "react";
import type { OrientationDebugSnapshot } from "../camera/cameraOrientation";
import type { FemViewportNavigation, FemViewportProjection } from "./FemViewportTypes";
import type { RenderMode } from "./femMeshTypes";

function formatVector(values: readonly number[], digits = 3): string {
  return values.map((value) => value.toFixed(digits)).join(", ");
}

function RotationSnapshotCard({
  label,
  snapshot,
}: {
  label: string;
  snapshot: OrientationDebugSnapshot | null | undefined;
}) {
  return (
    <div className="rounded-md border border-border/35 bg-background/35 px-2 py-2">
      <div className="text-[0.58rem] font-bold uppercase tracking-[0.16em] text-foreground/90">
        {label}
      </div>
      {snapshot ? (
        <div className="mt-1 space-y-1 text-[0.6rem] leading-4 text-muted-foreground">
          <div><span className="text-foreground/80">Euler</span>: {formatVector(snapshot.eulerDeg, 1)}</div>
          <div><span className="text-foreground/80">Quat</span>: {formatVector(snapshot.quaternion, 4)}</div>
          <div><span className="text-foreground/80">Up</span>: {formatVector(snapshot.up, 3)}</div>
          <div><span className="text-foreground/80">Sig</span>: <span className="break-all">{snapshot.signature}</span></div>
        </div>
      ) : (
        <div className="mt-1 text-[0.6rem] text-muted-foreground">No data.</div>
      )}
    </div>
  );
}

export function FemRotationDebugPanel({
  rotationSnapshots,
  projection,
  navigation,
  renderMode,
  quantityLabel,
  onApplyRotationEuler,
  actionClassName,
}: {
  rotationSnapshots?: {
    viewport: OrientationDebugSnapshot | null;
    viewCube: OrientationDebugSnapshot | null;
    hsl: OrientationDebugSnapshot | null;
  };
  projection: FemViewportProjection;
  navigation: FemViewportNavigation;
  renderMode: RenderMode;
  quantityLabel: string;
  onApplyRotationEuler?: (nextEulerDeg: [number, number, number]) => void;
  actionClassName: string;
}) {
  const rotationSource =
    rotationSnapshots?.viewport ?? rotationSnapshots?.viewCube ?? rotationSnapshots?.hsl ?? null;
  const rotationSourceSignature = rotationSource?.signature ?? "none";
  const sourceRotationDraft = useMemo<[string, string, string]>(
    () =>
      rotationSource
        ? (rotationSource.eulerDeg.map((value) => value.toFixed(1)) as [string, string, string])
        : ["0.0", "0.0", "0.0"],
    [rotationSource],
  );
  const [rotationDraftOverride, setRotationDraftOverride] = useState<{
    sourceSignature: string;
    values: [string, string, string];
  } | null>(null);
  const rotationDraft =
    rotationDraftOverride?.sourceSignature === rotationSourceSignature
      ? rotationDraftOverride.values
      : sourceRotationDraft;

  const setRotationDraft = useCallback(
    (
      update:
        | [string, string, string]
        | ((previous: [string, string, string]) => [string, string, string]),
    ) => {
      setRotationDraftOverride((previousOverride) => {
        const previous =
          previousOverride?.sourceSignature === rotationSourceSignature
            ? previousOverride.values
            : sourceRotationDraft;
        const next = typeof update === "function" ? update(previous) : update;
        if (previous[0] === next[0] && previous[1] === next[1] && previous[2] === next[2]) {
          return previousOverride;
        }
        return {
          sourceSignature: rotationSourceSignature,
          values: next,
        };
      });
    },
    [rotationSourceSignature, sourceRotationDraft],
  );

  return (
    <div className="space-y-3 text-[0.66rem] text-muted-foreground">
      <div className="grid grid-cols-3 gap-2">
        <RotationSnapshotCard label="Viewport" snapshot={rotationSnapshots?.viewport} />
        <RotationSnapshotCard label="ViewCube" snapshot={rotationSnapshots?.viewCube} />
        <RotationSnapshotCard label="HSL" snapshot={rotationSnapshots?.hsl} />
      </div>
      <div className="rounded-md border border-border/35 bg-background/40 px-3 py-3">
        <div className="mb-2 text-[0.58rem] font-bold uppercase tracking-[0.16em] text-foreground/90">
          Set Common Rotation
        </div>
        <div className="grid grid-cols-[auto_1fr_auto_1fr_auto_1fr_auto] items-center gap-2">
          <span className="text-muted-foreground">X</span>
          <input
            value={rotationDraft[0]}
            onChange={(event) => setRotationDraft(([, y, z]) => [event.target.value, y, z])}
            className="h-8 rounded border border-border/40 bg-background/70 px-2 font-mono text-[0.72rem] text-foreground outline-none focus:border-primary/50"
          />
          <span className="text-muted-foreground">Y</span>
          <input
            value={rotationDraft[1]}
            onChange={(event) => setRotationDraft(([x, , z]) => [x, event.target.value, z])}
            className="h-8 rounded border border-border/40 bg-background/70 px-2 font-mono text-[0.72rem] text-foreground outline-none focus:border-primary/50"
          />
          <span className="text-muted-foreground">Z</span>
          <input
            value={rotationDraft[2]}
            onChange={(event) => setRotationDraft(([x, y]) => [x, y, event.target.value])}
            className="h-8 rounded border border-border/40 bg-background/70 px-2 font-mono text-[0.72rem] text-foreground outline-none focus:border-primary/50"
          />
          <button
            className={actionClassName}
            onClick={() => {
              const nextEuler = rotationDraft.map((value) => Number.parseFloat(value)) as [number, number, number];
              if (nextEuler.every((value) => Number.isFinite(value))) {
                onApplyRotationEuler?.(nextEuler);
              }
            }}
          >
            Apply
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-border/30 bg-background/40 px-3 py-2">
        <span className="text-muted-foreground">Projection</span>
        <span className="font-mono text-right">{projection}</span>
        <span className="text-muted-foreground">Navigation</span>
        <span className="font-mono text-right">{navigation}</span>
        <span className="text-muted-foreground">Render</span>
        <span className="font-mono text-right">{renderMode}</span>
        <span className="text-muted-foreground">Quantity</span>
        <span className="font-mono text-right">{quantityLabel}</span>
      </div>
    </div>
  );
}
