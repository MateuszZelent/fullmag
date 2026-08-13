export interface PlanarColorizeRequest {
  colormap?: string;
  contours?: { enabled: boolean; level: number };
  height: number;
  id: number;
  kind: "colorize";
  mask?: Uint8Array;
  opacity?: number;
  range: { max: number; min: number };
  values: Float32Array | Float64Array;
  width: number;
}

export interface PlanarColorizeResponse {
  contours: readonly (readonly [number, number, number, number])[];
  id: number;
  kind: "colorized";
  pixels: Uint8ClampedArray;
}
