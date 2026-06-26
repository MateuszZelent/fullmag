import type { TopologicalChargeResource } from "@/kernel/api/apiTypes";

export interface TopologicalChargePanelRow {
  label: string;
  value: string;
}

export interface TopologicalChargePanelBanner {
  kind: "error" | "warning";
  message: string;
}

export interface TopologicalChargePanelModel {
  banner: TopologicalChargePanelBanner | undefined;
  rows: TopologicalChargePanelRow[];
}

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

function formatSampleGrid(resource: TopologicalChargeResource | null): string {
  if (!resource?.sample_grid) return "unavailable";
  const grid = resource.sample_grid;
  return `${grid.plane} ${grid.nx} x ${grid.ny}, ${resource.valid_sample_count}/${resource.sample_count} valid`;
}

function formatStatusForSentence(status: string): string {
  return status.replace(/_/g, " ");
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
    rows: [
      { label: "Object", value: data?.object_id ?? "none" },
      { label: "Fetch state", value: fetchStatus },
      { label: "Status", value: data?.status ?? fetchStatus },
      { label: "Quantity", value: data?.quantity_id ?? "m" },
      { label: "Q", value: formatMaybeNumber(data?.charge) },
      { label: "Nearest integer", value: formatMaybeInteger(data?.nearest_integer) },
      { label: "Integer error", value: formatMaybeNumber(data?.integer_error) },
      { label: "Polarity", value: formatMaybeText(data?.polarity) },
      { label: "Sampling", value: formatSampleGrid(data) },
      { label: "Method", value: formatMaybeText(data?.method) },
      { label: "Field revision", value: formatMaybeInteger(data?.field_revision) },
      { label: "Mesh revision", value: formatMaybeInteger(data?.mesh_revision) },
      { label: "Domain generation", value: formatMaybeText(data?.domain_generation_id) },
      { label: "Mesh generation", value: formatMaybeText(data?.mesh_generation_id) },
    ],
  };
}
