import { useEffect, useRef } from "react";

import type { FieldMapRenderModel } from "../model/fieldMapRenderModel";
import { clonePlanarMaskForWorker, clonePlanarValuesForWorker } from "./planarColorizer";
import type { PlanarStreamlineInput, PlanarStreamlines } from "./planarStreamlines";

/**
 * Traces in-plane streamlines of the displayed vector raster in a worker
 * (note 0970, `eq-planar-streamlines`). A new sample, mask or density replaces
 * the pending request; stale results are dropped by request id.
 */
export function usePlanarStreamlines(
  model: FieldMapRenderModel,
  onResult: (result: PlanarStreamlines | null) => void,
) {
  const workerRef = useRef<Worker | null>(null);
  const latestIdRef = useRef(0);
  const onResultRef = useRef(onResult);
  const enabled = Boolean(model.layers.streamlines && model.vectors);
  const { mask, vectorBudget, vectors } = model;
  // Primitive deps: the model rebuilds equal arrays on presentation-only renders.
  const [uMin, uMax, vMin, vMax] = model.bounds;
  const [gridWidth, gridHeight] = model.resolution;

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    if (!enabled || !vectors) {
      latestIdRef.current += 1;
      onResultRef.current(null);
      return;
    }
    if (!workerRef.current) {
      const worker = new Worker(new URL("./planarStreamlineWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ id: number; result: PlanarStreamlines }>) => {
        if (event.data.id === latestIdRef.current) onResultRef.current(event.data.result);
      };
      workerRef.current = worker;
    }
    const id = latestIdRef.current + 1;
    latestIdRef.current = id;
    const workerVectors = clonePlanarValuesForWorker(vectors);
    const workerMask = clonePlanarMaskForWorker(mask);
    const input: PlanarStreamlineInput = {
      bounds: [uMin, uMax, vMin, vMax],
      budget: vectorBudget,
      gridHeight,
      gridWidth,
      mask: workerMask ?? null,
      vectors: workerVectors,
    };
    const transfers: Transferable[] = [workerVectors.buffer];
    if (workerMask) transfers.push(workerMask.buffer);
    workerRef.current.postMessage({ id, input }, transfers);
  }, [enabled, gridHeight, gridWidth, mask, uMax, uMin, vMax, vMin, vectorBudget, vectors]);

  useEffect(() => () => {
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);
}
