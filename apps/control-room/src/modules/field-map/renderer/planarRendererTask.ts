import { colorizeScalarRaster } from "./colorRaster";
import type {
  PlanarColorizeRequest,
  PlanarColorizeResponse,
} from "./planarRendererProtocol";

export function colorizePlanarRendererRequest(
  request: PlanarColorizeRequest,
): PlanarColorizeResponse {
  return {
    id: request.id,
    kind: "colorized",
    pixels: colorizeScalarRaster(
      request.values,
      request.range,
      request.mask,
    ),
  };
}
