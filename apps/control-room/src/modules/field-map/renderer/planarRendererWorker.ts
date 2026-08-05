/// <reference lib="webworker" />

import type { PlanarColorizeRequest } from "./planarRendererProtocol";
import { colorizePlanarRendererRequest } from "./planarRendererTask";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<PlanarColorizeRequest>) => {
  const response = colorizePlanarRendererRequest(event.data);
  self.postMessage(response, [response.pixels.buffer]);
};
