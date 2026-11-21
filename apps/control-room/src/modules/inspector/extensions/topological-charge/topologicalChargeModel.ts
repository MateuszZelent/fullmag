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

const CONTINUUM_EQUATION_TEXT =
  "Q_\u03a3 = (1 / 4\u03c0) \u222b_\u03a3 m\u0302 \u00b7 (\u2202_u m\u0302 \u00d7 \u2202_v m\u0302) du dv";

const DISCRETE_EQUATION_TEXT =
  "Q_h(s_i) = (1 / 4\u03c0) \u2211_\u25b5 2 atan2(a \u00b7 (b \u00d7 c), 1 + a \u00b7 b + b \u00b7 c + c \u00b7 a)";

const METHOD_TERMS: TopologicalChargeMethodTerm[] = [
  {
    symbol: "\u03a3",
    meaning: "selected oriented 2D support: FDM grid plane or exact FEM P1 plane cut",
  },
  {
    symbol: "m\u0302",
    meaning: "unit magnetization direction sampled from quantity m",
  },
  {
    symbol: "u, v",
    meaning: "oriented in-plane coordinates of the selected analysis plane",
  },
  {
    symbol: "s\u1d62",
    meaning: "physical FDM-plane or FEM-cut coordinate along the selected support normal",
  },
  {
    symbol: "a, b, c",
    meaning: "normalized magnetization vectors on one oriented support triangle",
  },
  {
    symbol: "\u03a9\u25b5",
    meaning: "oriented solid angle contributed by one triangle",
  },
];

const MISSING_VALUE = "\u2014";

function formatMaybeNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(6)
    : MISSING_VALUE;
}

function formatMaybeInteger(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : MISSING_VALUE;
}

function formatMaybeText(value: string | number | null | undefined): string {
  return value !== null && value !== undefined && String(value).length > 0
    ? String(value)
    : MISSING_VALUE;
}

function formatExecution(
  execution: TopologicalChargeResource["provenance"]["requested_execution"] | null | undefined,
): string {
  if (!execution) return MISSING_VALUE;
  const identity = [execution.backend, execution.device, execution.precision, execution.mode]
    .filter((value) => value.length > 0)
    .join(" / ");
  return execution.lossy_fallback_used ? `${identity} (fallback)` : identity || MISSING_VALUE;
}

function formatSampling(resource: TopologicalChargeResource | null): string {
  if (!resource?.quality) return MISSING_VALUE;
  const quality = resource.quality;
  return `${quality.valid_vertex_count}/${quality.total_vertex_count} valid vertices, ${quality.valid_triangle_count}/${quality.total_triangle_count} valid triangles`;
}

function formatLayerProfile(resource: TopologicalChargeResource | null): string {
  const layers = resource?.profile ?? [];
  if (layers.length === 0) return MISSING_VALUE;
  const charges = layers
    .map((layer) => layer.charge)
    .filter((charge): charge is number => typeof charge === "number" && Number.isFinite(charge));
  if (charges.length === 0) return `${layers.length} layers, no valid layer charge`;
  if (layers.length === 1) {
    const layer = layers[0]!;
    return `1 support, Q=${charges[0]!.toFixed(6)} at s=${layer.coordinate_m.toExponential(3)} m`;
  }
  const min = Math.min(...charges);
  const max = Math.max(...charges);
  return `${layers.length} supports, Q(s)=${min.toFixed(6)}..${max.toFixed(6)}`;
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
  if (!resource?.quality || resource.quality.total_triangle_count <= 0) return MISSING_VALUE;
  const { valid_triangle_count, total_triangle_count } = resource.quality;
  const fraction = valid_triangle_count / total_triangle_count;
  return `${valid_triangle_count}/${total_triangle_count} valid triangles (${(fraction * 100).toFixed(2)}%)`;
}

function resolveMethodInfo(
  resource: TopologicalChargeResource | null,
): TopologicalChargeMethodInfo {
  return {
    title: "Berg-Luescher topological charge",
    description:
      "Computes skyrmion charge on an oriented 2D support from canonical magnetization m. A profile reports each physical cut and Q is present only when its requested support is valid.",
    continuumEquationLatex: CONTINUUM_EQUATION_TEXT,
    discreteEquationLatex: DISCRETE_EQUATION_TEXT,
    sampleQuality: formatSampleQuality(resource),
    terms: METHOD_TERMS,
    notes: [
      "Q is dimensionless; integer-like values are meaningful only when the full texture and boundary state are resolved.",
      "Q is computed on an oriented 2D support; unordered 3D nodes are not summed into a skyrmion number.",
      "For 3D FDM/FEM films, inspect Q(s) and its physical integration weights when the texture varies through thickness.",
      "Zero, missing, or non-finite vectors are rejected before the solid-angle sum.",
    ],
  };
}

function resolveBanner(
  resource: TopologicalChargeResource | null,
): TopologicalChargePanelBanner | undefined {
  if (!resource) return undefined;
  const firstWarning = resource.warnings?.[0];
  if (firstWarning) {
    return {
      kind: "warning",
      message: firstWarning.message,
    };
  }
  if (resource.status !== "ready") {
    return {
      kind: "warning",
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
      { label: "Schema", value: data?.schema_version ?? MISSING_VALUE },
      { label: "Quantity", value: data?.method?.quantity_id ?? "m" },
      { label: "Q", value: formatMaybeNumber(data?.charge) },
      { label: "Nearest integer", value: formatMaybeInteger(data?.nearest_integer) },
      { label: "Integer error", value: formatMaybeNumber(data?.integer_error) },
      { label: "Trust", value: formatMaybeText(data?.trust) },
      { label: "Plane", value: formatMaybeText(data?.resolved_support?.plane) },
      { label: "Support", value: formatMaybeText(data?.resolved_support?.support) },
      { label: "Sampling", value: formatSampling(data) },
      { label: "Support profile", value: formatLayerProfile(data) },
      { label: "Method", value: formatMaybeText(data?.method?.id) },
      { label: "Field revision", value: formatMaybeText(data?.provenance?.field_revision) },
      { label: "Mesh revision", value: formatMaybeText(data?.provenance?.mesh_revision) },
      { label: "Domain generation", value: formatMaybeText(data?.provenance?.domain_generation_id) },
      { label: "Mesh generation", value: formatMaybeText(data?.provenance?.mesh_generation_id) },
      { label: "Requested execution", value: formatExecution(data?.provenance?.requested_execution) },
      { label: "Resolved execution", value: formatExecution(data?.provenance?.resolved_execution) },
    ],
  };
}
