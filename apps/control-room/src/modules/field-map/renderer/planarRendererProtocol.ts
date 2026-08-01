export interface PlanarColorizeRequest {
  id: number;
  kind: "colorize";
  mask?: Uint8Array;
  range: { max: number; min: number };
  values: Float32Array | Float64Array;
}

export interface PlanarColorizeResponse {
  id: number;
  kind: "colorized";
  pixels: Uint8ClampedArray;
}
