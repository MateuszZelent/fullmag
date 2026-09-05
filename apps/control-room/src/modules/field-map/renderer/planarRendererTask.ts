import { colorizeScalarRaster } from "./colorRaster";
import { marchingSquares, marchingSquaresLevels } from "./marchingSquares";
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
      { colormap: request.colormap, opacity: request.opacity },
    ),
    contours: request.contours?.enabled
      ? request.contours.levels && request.contours.levels.length > 0
        ? marchingSquaresLevels(
            request.values,
            request.width,
            request.height,
            request.contours.levels,
            request.mask,
          )
        : marchingSquares(
            request.values,
            request.width,
            request.height,
            request.contours.level ?? (request.range.min + request.range.max) / 2,
            request.mask,
          )
      : [],
  };
}
