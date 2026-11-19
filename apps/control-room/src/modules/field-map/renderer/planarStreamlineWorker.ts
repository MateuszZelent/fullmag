/// <reference lib="webworker" />

import { tracePlanarStreamlines, type PlanarStreamlineInput } from "./planarStreamlines";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<{ id: number; input: PlanarStreamlineInput }>) => {
  const result = tracePlanarStreamlines(event.data.input);
  self.postMessage({ id: event.data.id, result }, [result.points.buffer, result.offsets.buffer]);
};
