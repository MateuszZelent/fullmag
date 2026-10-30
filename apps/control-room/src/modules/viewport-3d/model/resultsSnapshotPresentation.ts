import type {
  ResultsArray,
  ResultsFdmGeometry,
  ResultsFemGeometry,
} from "@/kernel/api/resultsBrowser";
import type {
  SnapshotVisualizationAppearance,
  SnapshotVisualizationComponent,
} from "@/kernel/visualization/SnapshotVisualizationController";
import { scalarColorRgb } from "@/shared/visualization/scalarColorPalette";

const FDM_LAYOUTS = new Set(["aos_node_major", "soa_component_major"]);

export type ResultsSnapshotFieldLayout =
  | "aos_node_major"
  | "soa_component_major";

export interface ResultsSnapshotPresentationInput {
  values: Float64Array;
  componentCount: number;
  fieldLayout: string | null;
  nodeCount: number;
  sampleShape: readonly number[];
  activeNodes?: Uint8Array | null;
  appearance: SnapshotVisualizationAppearance;
}

export interface ResultsSnapshotPresentation {
  scalarValues: Float64Array;
  colors: Float32Array | null;
  range: { min: number; max: number };
  fieldLayout: ResultsSnapshotFieldLayout | "scalar";
}

export interface ResultsSnapshotPresentationResult {
  presentation: ResultsSnapshotPresentation | null;
  error: string | null;
}

/** Stable geometry identity for memoizing render geometry across samples. */
export function resultsSnapshotGeometryKey(
  geometry: ResultsArray["geometry"],
  sourceRevision: string,
): string | null {
  if (!geometry) return null;
  if (geometry.kind === "fdm") return JSON.stringify([
    "fdm",
    geometry.cells_xyz,
    geometry.cell_size_m,
    geometry.origin_m,
  ]);
  return JSON.stringify([
    "fem_p1",
    sourceRevision,
    geometry.node_count,
    geometry.cell_count,
  ]);
}

/**
 * Converts a bounded saved sample to one scalar per render node and a Three.js
 * RGB buffer.  The adapter owns all layout/range validation so React state
 * never contains a render buffer and malformed source data never reaches GL.
 */
export function presentResultsSnapshot(
  input: ResultsSnapshotPresentationInput,
): ResultsSnapshotPresentationResult {
  const validationError = validateInput(input);
  if (validationError) return { presentation: null, error: validationError };

  const layout = resolveLayout(input.componentCount, input.fieldLayout);
  if (layout.error) return { presentation: null, error: layout.error };

  const scalarValues = toScalarValues(
    input.values,
    input.componentCount,
    input.nodeCount,
    layout.value,
    input.appearance.component,
  );
  const activeNodes = input.activeNodes ?? null;
  const activeRange = scalarRange(scalarValues, activeNodes);
  if (!activeRange) {
    return {
      presentation: null,
      error: "Saved geometry has no active render nodes.",
    };
  }

  const range = resolveRange(input.appearance, activeRange);
  if (range.error) return { presentation: null, error: range.error };

  const colors = input.appearance.visible
    ? colorValues(scalarValues, range.value, input.appearance.palette)
    : null;
  return {
    presentation: {
      scalarValues,
      colors,
      range: range.value,
      fieldLayout: layout.value,
    },
    error: null,
  };
}

function validateInput(input: ResultsSnapshotPresentationInput): string | null {
  if (!["x", "y", "z", "magnitude"].includes(input.appearance.component)) {
    return "Saved visualization component is unsupported.";
  }
  if (typeof input.appearance.palette !== "string" || input.appearance.palette.trim().length === 0) {
    return "Saved visualization palette is unavailable.";
  }
  if (!["auto", "manual", "symmetric"].includes(input.appearance.rangeMode)) {
    return "Saved visualization range mode is unsupported.";
  }
  if ((input.appearance.min !== null && !Number.isFinite(input.appearance.min)) ||
      (input.appearance.max !== null && !Number.isFinite(input.appearance.max))) {
    return "Saved visualization limits must be finite values.";
  }
  if (!Number.isSafeInteger(input.componentCount) || ![1, 3].includes(input.componentCount)) {
    return "Saved field component count must be 1 or 3.";
  }
  if (!Number.isSafeInteger(input.nodeCount) || input.nodeCount <= 0) {
    return "Saved geometry node count is invalid.";
  }
  const expectedValues = input.nodeCount * input.componentCount;
  if (!Number.isSafeInteger(expectedValues) || input.values.length !== expectedValues) {
    return `Saved sample length does not match ${input.nodeCount} nodes and ${input.componentCount} components.`;
  }
  if (input.sampleShape.length === 0 || input.sampleShape.some((dimension) => !Number.isSafeInteger(dimension) || dimension <= 0)) {
    return "Saved sample shape is invalid.";
  }
  const shapeValues = input.sampleShape.reduce((product, dimension) => product * dimension, 1);
  if (!Number.isSafeInteger(shapeValues) || shapeValues !== expectedValues) {
    return "Saved sample shape does not match its geometry mapping.";
  }
  if (input.activeNodes && input.activeNodes.length !== input.nodeCount) {
    return "Saved active-node support does not match its geometry.";
  }
  for (const value of input.values) {
    if (!Number.isFinite(value)) return "Saved sample contains a non-finite value.";
  }
  return null;
}

function resolveLayout(
  componentCount: number,
  fieldLayout: string | null,
): { value: ResultsSnapshotFieldLayout | "scalar"; error: string | null } {
  if (componentCount === 1) {
    return { value: "scalar", error: null };
  }
  const normalized = fieldLayout?.trim().toLowerCase() ?? "";
  if (!FDM_LAYOUTS.has(normalized)) {
    return {
      value: "aos_node_major",
      error: "Three-component saved samples require an explicit AoS or SoA layout.",
    };
  }
  return { value: normalized as ResultsSnapshotFieldLayout, error: null };
}

function toScalarValues(
  values: Float64Array,
  componentCount: number,
  nodeCount: number,
  layout: ResultsSnapshotFieldLayout | "scalar",
  component: SnapshotVisualizationComponent,
): Float64Array {
  if (componentCount === 1) return values.slice();
  const scalarValues = new Float64Array(nodeCount);
  for (let node = 0; node < nodeCount; node += 1) {
    const x = layout === "aos_node_major" ? values[node * 3]! : values[node]!;
    const y = layout === "aos_node_major" ? values[node * 3 + 1]! : values[nodeCount + node]!;
    const z = layout === "aos_node_major" ? values[node * 3 + 2]! : values[nodeCount * 2 + node]!;
    scalarValues[node] = componentValue(x, y, z, component);
  }
  return scalarValues;
}

function componentValue(
  x: number,
  y: number,
  z: number,
  component: SnapshotVisualizationComponent,
): number {
  if (component === "x") return x;
  if (component === "y") return y;
  if (component === "z") return z;
  return Math.hypot(x, y, z);
}

function scalarRange(
  scalarValues: Float64Array,
  activeNodes: Uint8Array | null,
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < scalarValues.length; index += 1) {
    if (activeNodes && activeNodes[index] === 0) continue;
    const value = scalarValues[index]!;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

function resolveRange(
  appearance: SnapshotVisualizationAppearance,
  automatic: { min: number; max: number },
): { value: { min: number; max: number }; error: string | null } {
  if (appearance.rangeMode === "auto") return { value: automatic, error: null };
  if (appearance.rangeMode === "manual") {
    if (
      appearance.min === null ||
      appearance.max === null ||
      !Number.isFinite(appearance.min) ||
      !Number.isFinite(appearance.max) ||
      appearance.min >= appearance.max
    ) {
      return { value: automatic, error: "Manual saved-field range requires finite minimum < maximum." };
    }
    return { value: { min: appearance.min, max: appearance.max }, error: null };
  }

  const dataLimit = Math.max(Math.abs(automatic.min), Math.abs(automatic.max));
  const requestedLimit = Math.max(
    appearance.min === null ? 0 : Math.abs(appearance.min),
    appearance.max === null ? 0 : Math.abs(appearance.max),
  );
  const hasRequestedLimit = appearance.min !== null || appearance.max !== null;
  const limit = Math.max(
    hasRequestedLimit ? requestedLimit : dataLimit,
    Number.EPSILON,
  );
  return { value: { min: -limit, max: limit }, error: null };
}

function colorValues(
  scalarValues: Float64Array,
  range: { min: number; max: number },
  palette: string,
): Float32Array {
  const colors = new Float32Array(scalarValues.length * 3);
  const span = range.max - range.min;
  for (let index = 0; index < scalarValues.length; index += 1) {
    const normalized = span > 0 ? (scalarValues[index]! - range.min) / span : 0.5;
    colors.set(scalarColorRgb(normalized, palette), index * 3);
  }
  return colors;
}

export type { ResultsFdmGeometry, ResultsFemGeometry };
