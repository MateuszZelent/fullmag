/// <reference lib="webworker" />

import { colorizeScalarRaster } from "./colorRaster";
import type {
  PlanarColorizeRequest,
  PlanarColorizeResponse,
} from "./planarRendererProtocol";

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<PlanarColorizeRequest>) => {
  const request = event.data;
  const pixels = colorizeScalarRaster(
    request.values,
    request.range,
    request.mask,
  );
  const response: PlanarColorizeResponse = {
    id: request.id,
    kind: "colorized",
    pixels,
  };
  self.postMessage(response, [pixels.buffer]);
};
