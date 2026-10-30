/**
 * Client-side planar components (D2D-12: a component switch needs 0 requests).
 *
 * For a three-component, non-tensor quantity sampled with `plane_sample`, the
 * x, y, z and magnitude rasters are pointwise functions of the sampled world
 * vector, so they are derived from the vector raster of one carrier sample
 * instead of requesting a new sample per component. The backend keeps every
 * other case (tensors, scalar quantities, slab/depth/surface operators, frame
 * components such as u/v/normal or in-plane).
 */

export const CLIENT_DERIVABLE_PLANAR_COMPONENTS = ["x", "y", "z", "magnitude"] as const;
export type ClientDerivablePlanarComponent = (typeof CLIENT_DERIVABLE_PLANAR_COMPONENTS)[number];

/** Component of the carrier sample whose vectors feed client-side components. */
export const PLANAR_VECTOR_CARRIER_COMPONENT: ClientDerivablePlanarComponent = "magnitude";

export function isClientDerivablePlanarComponent(
  component: string | null | undefined,
): component is ClientDerivablePlanarComponent {
  return (CLIENT_DERIVABLE_PLANAR_COMPONENTS as readonly string[]).includes(component ?? "");
}

export function resolvePlanarComponentDerivation(input: {
  component: string | null | undefined;
  operatorKind: string | null | undefined;
  quantity: { components?: number | null; n_comp?: number | null; shape?: string | null; tensor?: unknown } | null | undefined;
}): "client" | "backend" {
  const quantity = input.quantity;
  if (!quantity) return "backend";
  const components = quantity.components ?? quantity.n_comp ?? null;
  const tensor = quantity.tensor != null || quantity.shape === "tensor_field";
  return components === 3 &&
    !tensor &&
    input.operatorKind === "plane_sample" &&
    isClientDerivablePlanarComponent(input.component)
    ? "client"
    : "backend";
}

/** Scalar raster of `component` from interleaved world vectors; NaN stays NaN. */
export function derivePlanarComponentScalar(
  worldVectors: ArrayLike<number>,
  component: ClientDerivablePlanarComponent,
): Float64Array {
  const count = Math.floor(worldVectors.length / 3);
  const out = new Float64Array(count);
  const axis = component === "x" ? 0 : component === "y" ? 1 : component === "z" ? 2 : -1;
  for (let index = 0; index < count; index += 1) {
    const x = worldVectors[index * 3] ?? Number.NaN;
    const y = worldVectors[index * 3 + 1] ?? Number.NaN;
    const z = worldVectors[index * 3 + 2] ?? Number.NaN;
    out[index] = axis === 0 ? x : axis === 1 ? y : axis === 2 ? z : Math.hypot(x, y, z);
  }
  return out;
}
