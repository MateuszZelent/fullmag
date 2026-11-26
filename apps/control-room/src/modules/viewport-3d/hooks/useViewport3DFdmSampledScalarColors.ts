"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { buildVertexScalarColorsOffMainThread } from "../viewport3dColorTransformScheduler";
import type { ScalarColorBuffer, ScalarRange, Viewport3DFieldVector } from "../viewport3dFieldMapping";

export interface Viewport3DFdmSampledScalarColorRequest {
  buildKey: string;
  cellOrdinals: Uint32Array;
  colorMode: string;
  colorPalette: string;
  compatibilityKey: string;
  diagnosticsCacheKey: string;
  domainCellCount: number;
  domainGridShape: readonly [number, number, number];
  fieldVector: Viewport3DFieldVector;
  groupKey: string;
  rangeSource: NonNullable<ScalarColorBuffer["rangeSource"]>;
  revisionSummary: string;
  scalarRange: ScalarRange | null;
  sourceFieldBufferId: string | null;
  sourceResourceKey: string | null;
  targetRevision: string;
  topologyRevision: string;
}

interface FdmScalarColorSnapshot {
  lastGoodByCompatibility: ReadonlyMap<string, ScalarColorBuffer>;
  resultsByBuildKey: ReadonlyMap<string, ScalarColorBuffer>;
  settledBuildKeys: ReadonlySet<string>;
}

const EMPTY_FDM_SCALAR_COLOR_SNAPSHOT: FdmScalarColorSnapshot = {
  lastGoodByCompatibility: new Map(),
  resultsByBuildKey: new Map(),
  settledBuildKeys: new Set(),
};

/** Builds FDM target colors in the shared viewport field-color worker. */
export function useViewport3DFdmSampledScalarColors(
  requests: readonly Viewport3DFdmSampledScalarColorRequest[],
): ReadonlyMap<string, ScalarColorBuffer> {
  const [snapshot, setSnapshot] = useState(EMPTY_FDM_SCALAR_COLOR_SNAPSHOT);
  const snapshotRef = useRef(snapshot);
  const controllersRef = useRef(new Map<string, AbortController>());

  useEffect(() => {
    const publish = (
      update: (current: FdmScalarColorSnapshot) => FdmScalarColorSnapshot,
    ) => {
      const current = snapshotRef.current;
      const next = update(current);
      if (next === current) return;
      snapshotRef.current = next;
      setSnapshot(next);
    };
    const buildKeys = new Set(requests.map(({ buildKey }) => buildKey));
    const compatibilityKeys = new Set(
      requests.map(({ compatibilityKey }) => compatibilityKey),
    );

    for (const [key, controller] of controllersRef.current) {
      if (buildKeys.has(key)) continue;
      controller.abort();
      controllersRef.current.delete(key);
    }
    publish((current) => {
      const resultsByBuildKey = new Map(
        [...current.resultsByBuildKey].filter(([key]) => buildKeys.has(key)),
      );
      const lastGoodByCompatibility = new Map(
        [...current.lastGoodByCompatibility].filter(([key]) =>
          compatibilityKeys.has(key),
        ),
      );
      const settledBuildKeys = new Set(
        [...current.settledBuildKeys].filter((key) => buildKeys.has(key)),
      );
      if (
        resultsByBuildKey.size === current.resultsByBuildKey.size &&
        lastGoodByCompatibility.size === current.lastGoodByCompatibility.size &&
        settledBuildKeys.size === current.settledBuildKeys.size
      ) {
        return current;
      }
      return {
        lastGoodByCompatibility,
        resultsByBuildKey,
        settledBuildKeys,
      };
    });

    for (const request of requests) {
      const current = snapshotRef.current;
      if (
        current.resultsByBuildKey.has(request.buildKey) ||
        current.settledBuildKeys.has(request.buildKey) ||
        controllersRef.current.has(request.buildKey)
      ) {
        continue;
      }
      const controller = new AbortController();
      controllersRef.current.set(request.buildKey, controller);
      void buildVertexScalarColorsOffMainThread(request.fieldVector, {
        buildKey: request.buildKey,
        colorMode: request.colorMode,
        colorPalette: request.colorPalette,
        groupKey: request.groupKey,
        latestWins: true,
        revisionSummary: request.revisionSummary,
        scalarRange: request.scalarRange,
        signal: controller.signal,
        target: {
          cellOrdinals: request.cellOrdinals,
          diagnosticsCacheKey: request.diagnosticsCacheKey,
          domainCellCount: request.domainCellCount,
          domainGridShape: request.domainGridShape,
          kind: "fdm-sampled",
        },
        workerRequired: true,
      }).then(
        (colors) => {
          if (controllersRef.current.get(request.buildKey) !== controller) return;
          controllersRef.current.delete(request.buildKey);
          const completed: ScalarColorBuffer = {
            ...colors,
            buildKey: request.buildKey,
            rangeSource: request.rangeSource,
            sourceFieldBufferId: request.sourceFieldBufferId,
            sourceResourceKey: request.sourceResourceKey,
            targetRevision: request.targetRevision,
            topologyRevision: request.topologyRevision,
          };
          publish((currentSnapshot) => {
            const resultsByBuildKey = new Map(currentSnapshot.resultsByBuildKey);
            resultsByBuildKey.set(request.buildKey, completed);
            const lastGoodByCompatibility = new Map(
              currentSnapshot.lastGoodByCompatibility,
            );
            lastGoodByCompatibility.set(request.compatibilityKey, completed);
            const settledBuildKeys = new Set(currentSnapshot.settledBuildKeys);
            settledBuildKeys.add(request.buildKey);
            return {
              lastGoodByCompatibility,
              resultsByBuildKey,
              settledBuildKeys,
            };
          });
        },
        () => {
          if (controllersRef.current.get(request.buildKey) !== controller) return;
          controllersRef.current.delete(request.buildKey);
          publish((current) => {
            const settledBuildKeys = new Set(current.settledBuildKeys);
            settledBuildKeys.add(request.buildKey);
            return { ...current, settledBuildKeys };
          });
        },
      );
    }
  }, [requests]);

  useEffect(
    () => () => {
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
      snapshotRef.current = EMPTY_FDM_SCALAR_COLOR_SNAPSHOT;
    },
    [],
  );

  return useMemo(() => {
    const colors = new Map<string, ScalarColorBuffer>();
    for (const request of requests) {
      const color =
        snapshot.resultsByBuildKey.get(request.buildKey) ??
        snapshot.lastGoodByCompatibility.get(request.compatibilityKey);
      if (color) colors.set(request.buildKey, color);
    }
    return colors;
  }, [requests, snapshot]);
}
