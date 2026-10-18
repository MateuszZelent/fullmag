import type { DecodedFieldVector } from "./codecs/types";

export type TensorProjectionToken =
  | "c0" | "c1" | "c2" | "c3" | "c4" | "c5" | "c6" | "c7" | "c8"
  | "frobenius" | "spin_flow_x" | "spin_flow_y" | "spin_flow_z";

export interface TensorFieldDescriptor {
  rank: number;
  shape: readonly number[];
  layout: string;
  axes: readonly string[];
  component_labels: readonly string[];
}

export function isFlowMajorTensorDescriptor(
  value: TensorFieldDescriptor | null | undefined,
): value is TensorFieldDescriptor {
  return value?.rank === 2 && Array.isArray(value.shape) && value.shape.length === 2 &&
    value.shape[0] === 3 && value.shape[1] === 3 &&
    value.layout === "flow_major" && Array.isArray(value.axes) && value.axes.length === 2 &&
    value.axes[0] === "flow" && value.axes[1] === "spin" &&
    Array.isArray(value.component_labels) && value.component_labels.length === 9 &&
    value.component_labels.every((label) => typeof label === "string" && label.trim().length > 0);
}

export function normalizeTensorProjection(value: unknown): TensorProjectionToken | null {
  return typeof value === "string" &&
    (/^c[0-8]$/.test(value) || value === "frobenius" || /^spin_flow_[xyz]$/.test(value))
    ? value as TensorProjectionToken : null;
}

export function tensorProjectionOutputKind(value: unknown): "scalar" | "vector" | null {
  const token = normalizeTensorProjection(value);
  return token ? token.startsWith("spin_flow_") ? "vector" : "scalar" : null;
}

export function tensorProjectionOptions(descriptor: TensorFieldDescriptor | null | undefined):
  { value: TensorProjectionToken; label: string }[] {
  if (!isFlowMajorTensorDescriptor(descriptor)) return [];
  return [
    ...descriptor.component_labels.map((label, index) => ({ value: `c${index}` as TensorProjectionToken, label })),
    { value: "frobenius" as const, label: "Frobenius norm" },
    ...(["x", "y", "z"] as const).map((axis) => ({
      value: `spin_flow_${axis}` as TensorProjectionToken,
      label: `Flow vector, spin ${axis.toUpperCase()}`,
    })),
  ];
}

export function tensorProjectionComponentLabels(
  descriptor: TensorFieldDescriptor | null | undefined,
  projection: string | null | undefined,
  componentCount: number,
): readonly string[] | null {
  if (!isFlowMajorTensorDescriptor(descriptor)) return null;
  if (projection === "full" && componentCount === 9) return descriptor.component_labels;
  const token = normalizeTensorProjection(projection);
  if (!token) return null;
  if (token.startsWith("c") && componentCount === 1) return [descriptor.component_labels[Number(token.slice(1))]];
  if (token === "frobenius" && componentCount === 1) return ["Frobenius norm"];
  if (token.startsWith("spin_flow_") && componentCount === 3) {
    const spin = "xyz".indexOf(token.at(-1)!);
    return [0, 1, 2].map((flow) => descriptor.component_labels[3 * flow + spin]);
  }
  return null;
}

const projections = new WeakMap<DecodedFieldVector, Map<TensorProjectionToken, DecodedFieldVector>>();

/** Project a nodal carrier without changing its scope, indexing, or physical identity. */
export function projectTensorField(
  field: DecodedFieldVector,
  descriptor: TensorFieldDescriptor | null | undefined,
  value: unknown,
): DecodedFieldVector {
  const token = normalizeTensorProjection(value);
  if (!isFlowMajorTensorDescriptor(descriptor) || !token || field.nComp !== 9 ||
    field.valueCount !== field.pointCount * 9 || field.values.length !== field.valueCount) {
    throw new Error("Tensor projection requires a complete flow-major 3x3 descriptor and carrier");
  }
  let cache = projections.get(field);
  const cached = cache?.get(token);
  if (cached) return cached;
  const vector = tensorProjectionOutputKind(token) === "vector";
  const nComp = vector ? 3 : 1;
  const values = new Float64Array(field.pointCount * nComp);
  const spin = vector ? "xyz".indexOf(token.at(-1)!) : 0;
  const component = token.startsWith("c") ? Number(token.slice(1)) : 0;
  for (let point = 0; point < field.pointCount; point += 1) {
    const start = point * 9;
    if (vector) {
      for (let flow = 0; flow < 3; flow += 1) {
        values[point * 3 + flow] = field.values[start + flow * 3 + spin];
      }
    } else if (token === "frobenius") {
      let norm = 0;
      for (let index = 0; index < 9; index += 1) norm = Math.hypot(norm, field.values[start + index]);
      values[point] = norm;
    } else {
      values[point] = field.values[start + component];
    }
  }
  const projected = { ...field, nComp, valueCount: values.length, values, projectionToken: token };
  if (!cache) { cache = new Map(); projections.set(field, cache); }
  cache.set(token, projected);
  return projected;
}

export interface TensorSurfaceField {
  nComp: number;
  pointCount: number;
  valueCount: number;
  values: Float32Array | Float64Array;
  projectionToken: "frobenius";
  tensorSurfaceDescriptor: TensorFieldDescriptor;
}

export function isTensorFrobeniusSurfaceField<T extends { nComp: number }>(field: T): field is T & TensorSurfaceField {
  const tensor: Partial<TensorSurfaceField> = field;
  return tensor.projectionToken === "frobenius" && isFlowMajorTensorDescriptor(tensor.tensorSurfaceDescriptor) &&
    tensor.nComp === 9 && typeof tensor.pointCount === "number" && tensor.valueCount === tensor.pointCount * 9 &&
    (tensor.values instanceof Float32Array || tensor.values instanceof Float64Array) && tensor.values.length === tensor.valueCount;
}

const surfaceFields = new WeakMap<DecodedFieldVector, Map<TensorFieldDescriptor, DecodedFieldVector>>();
export function retainTensorSurfaceField(field: DecodedFieldVector, descriptor: TensorFieldDescriptor | null | undefined): DecodedFieldVector {
  if (!isFlowMajorTensorDescriptor(descriptor) || field.nComp !== 9 || field.valueCount !== field.pointCount * 9 || field.values.length !== field.valueCount) {
    throw new Error("Tensor surface requires a complete flow-major 3x3 descriptor and carrier");
  }
  let cache = surfaceFields.get(field);
  const previous = cache?.get(descriptor);
  if (previous) return previous;
  const retained = { ...field, projectionToken: "frobenius", tensorSurfaceDescriptor: descriptor };
  if (!cache) { cache = new Map(); surfaceFields.set(field, cache); }
  cache.clear();
  cache.set(descriptor, retained);
  return retained;
}

/** Interpolate all components before taking a norm; weights belong to the actual carrier. */
export function interpolatedTensorFrobenius(values: ArrayLike<number>, indices: readonly number[], weights: readonly number[]): number {
  if (indices.length !== weights.length || indices.length === 0) throw new Error("Invalid tensor interpolation weights");
  let norm = 0;
  for (let component = 0; component < 9; component++) {
    let value = 0;
    for (let point = 0; point < indices.length; point++) value += values[indices[point] * 9 + component] * weights[point];
    norm = Math.hypot(norm, value);
  }
  return norm;
}
