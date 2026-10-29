import { colorizeDirectionRaster, colorizeScalarRaster } from "./colorRaster";
import { marchingSquares } from "./marchingSquares";
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
    pixels: request.directionVectors
      ? colorizeDirectionRaster(request.directionVectors, request.mask, {
          opacity: request.opacity,
        })
      : colorizeScalarRaster(
          request.values,
          request.range,
          request.mask,
          { colormap: request.colormap, opacity: request.opacity },
        ),
    contours: request.contours?.enabled
      ? marchingSquares(
          request.values,
          request.width,
          request.height,
          request.contours.level,
          request.mask,
        )
      : [],
  };
}
