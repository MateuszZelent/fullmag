import type { TopologicalChargeResource } from "@/kernel/api/apiTypes";

export interface TopologicalChargePanelRow {
  label: string;
  value: string;
}

export interface TopologicalChargePanelBanner {
  kind: "error" | "warning";
  message: string;
}

export interface TopologicalChargeMethodTerm {
  symbol: string;
  meaning: string;
}

export interface TopologicalChargeMethodInfo {
  title: string;
  description: string;
  continuumEquationLatex: string;
  discreteEquationLatex: string;
  sampleQuality: string;
  terms: TopologicalChargeMethodTerm[];
  notes: string[];
}

export interface TopologicalChargePanelModel {
  banner: TopologicalChargePanelBanner | undefined;
  method: TopologicalChargeMethodInfo;
  rows: TopologicalChargePanelRow[];
}

const CONTINUUM_EQUATION_LATEX =
  "Q = \\frac{1}{4\\pi}\\int_{\\Omega}\\hat{\\mathbf m}\\cdot\\left(\\partial_u\\hat{\\mathbf m}\\times\\partial_v\\hat{\\mathbf m}\\right)\\,du\\,dv";

const DISCRETE_EQUATION_LATEX =
  "Q_h = \\frac{1}{4\\pi}\\sum_{\\triangle}2\\operatorname{atan2}\\left(a\\cdot(b\\times c),1+a\\cdot b+b\\cdot c+c\\cdot a\\right)";

const METHOD_TERMS: TopologicalChargeMethodTerm[] = [
  {
    symbol: "\\hat{\\mathbf m}",
    meaning: "unit magnetization direction sampled from quantity m",
  },
  {
    symbol: "u, v",
    meaning: "oriented in-plane coordinates of the selected analysis plane",
  },
  {
    symbol: "z_i",
    meaning: "FEM layer coordinate along the selected plane normal",
  },
  {
    symbol: "a, b, c",
    meaning: "normalized magnetization vectors on one oriented grid or FEM layer triangle",
  },
  {
    symbol: "\\Omega_\\triangle",
    meaning: "oriented solid angle contributed by one triangle",
  },
];

function formatMaybeNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(6)
    : "unavailable";
}

function formatMaybeInteger(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "unavailable";
}

function formatMaybeText(value: string | number | null | undefined): string {
  return value !== null && value !== undefined && String(value).length > 0
    ? String(value)
    : "unavailable";
}

function formatSampling(resource: TopologicalChargeResource | null): string {
  if (!resource) return "unavailable";
  if (resource.sample_topology) {
    const topology = resource.sample_topology;
    return `${formatTopologyKind(topology.kind)}, ${topology.point_count} nodes, ${topology.triangle_count} triangles, ${resource.valid_sample_count}/${resource.sample_count} valid`;
  }
  if (!resource.sample_grid) return "unavailable";
  const grid = resource.sample_grid;
  return `${grid.plane} ${grid.nx} x ${grid.ny}, ${resource.valid_sample_count}/${resource.sample_count} valid`;
}

function formatTopologyKind(kind: string): string {
  return kind.replace(/_/g, " ");
}

function formatLayerProfile(resource: TopologicalChargeResource | null): string {
  const layers = resource?.layer_samples ?? [];
  if (layers.length === 0) return "unavailable";
  const charges = layers
    .map((layer) => layer.charge)
    .filter((charge): charge is number => typeof charge === "number" && Number.isFinite(charge));
  if (charges.length === 0) return `${layers.length} layers, no valid layer charge`;
  if (layers.length === 1) {
    const layer = layers[0];
    return `1 support, Q ${charges[0].toFixed(6)} at s=${layer.coordinate.toExponential(3)}`;
  }
  const min = Math.min(...charges);
  const max = Math.max(...charges);
  return `${layers.length} supports, Q(s) ${min.toFixed(6)} .. ${max.toFixed(6)}`;
}

function formatStatusForSentence(status: string): string {
  switch (status) {
    case "no_current_magnetization":
      return "no current magnetization";
    case "empty_support":
      return "no valid 2D support";
    case "invalid_magnetization":
      return "invalid magnetization";
    case "degenerate_support":
      return "degenerate 2D support";
    default:
      return status.replace(/_/g, " ");
  }
}

function formatSampleQuality(resource: TopologicalChargeResource | null): string {
  if (!resource || resource.sample_count <= 0) return "unavailable";
  const fraction = resource.valid_sample_count / resource.sample_count;
  return `${resource.valid_sample_count}/${resource.sample_count} valid samples (${(fraction * 100).toFixed(2)}%)`;
}

function resolveMethodInfo(
  resource: TopologicalChargeResource | null,
): TopologicalChargeMethodInfo {
  return {
    title: "Berg-Luescher topological charge",
    description:
      "Computes an object-scoped skyrmion charge from normalized magnetization directions. FDM uses the selected native grid plane. FEM uses mesh-native surface, layer, or exact tetra-plane-cut triangles.",
    continuumEquationLatex: CONTINUUM_EQUATION_LATEX,
    discreteEquationLatex: DISCRETE_EQUATION_LATEX,
    sampleQuality: formatSampleQuality(resource),
    terms: METHOD_TERMS,
    notes: [
      "Q is dimensionless; integer-like values are meaningful only when the full texture and boundary state are resolved.",
      "Q is computed on an oriented 2D support; unordered 3D nodes are not summed into a skyrmion number.",
      "For FEM films, inspect the layer profile when the texture varies through thickness.",
      "Zero, missing, or non-finite vectors are rejected before the solid-angle sum.",
    ],
  };
}

function resolveBanner(
  resource: TopologicalChargeResource | null,
): TopologicalChargePanelBanner | undefined {
  if (!resource) return undefined;
  const firstWarning = resource.warnings[0];
  if (firstWarning) {
    return {
      kind: "warning",
      message: firstWarning.message,
    };
  }
  if (resource.status !== "ready") {
    return {
      kind: resource.status === "error" ? "error" : "warning",
      message: `Topological charge status: ${formatStatusForSentence(resource.status)}.`,
    };
  }
  return undefined;
}

export function resolveTopologicalChargePanelModel(
  fetchStatus: string,
  resource: TopologicalChargeResource | null | undefined,
): TopologicalChargePanelModel {
  const data = resource ?? null;
  return {
    banner: resolveBanner(data),
    method: resolveMethodInfo(data),
    rows: [
      { label: "Object", value: data?.object_id ?? "none" },
      { label: "Fetch state", value: fetchStatus },
      { label: "Status", value: data?.status ?? fetchStatus },
      { label: "Quantity", value: data?.quantity_id ?? "m" },
      { label: "Q", value: formatMaybeNumber(data?.charge) },
      { label: "Nearest integer", value: formatMaybeInteger(data?.nearest_integer) },
      { label: "Integer error", value: formatMaybeNumber(data?.integer_error) },
      { label: "Polarity", value: formatMaybeText(data?.polarity) },
      { label: "Sampling", value: formatSampling(data) },
      { label: "Support profile", value: formatLayerProfile(data) },
      { label: "Method", value: formatMaybeText(data?.method) },
      { label: "Field revision", value: formatMaybeInteger(data?.field_revision) },
      { label: "Mesh revision", value: formatMaybeInteger(data?.mesh_revision) },
      { label: "Domain generation", value: formatMaybeText(data?.domain_generation_id) },
      { label: "Mesh generation", value: formatMaybeText(data?.mesh_generation_id) },
    ],
  };
}
