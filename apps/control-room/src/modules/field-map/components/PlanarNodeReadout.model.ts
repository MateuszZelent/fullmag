import { type PlanarNodeProbeResult } from "../hooks/usePlanarNodeProbes";
import { type PlanarCursorUv } from "@/kernel/visualization/planarToolStore";

const VECTOR_AXES = ["x", "y", "z"] as const;

const STATUS_COPY: Partial<Record<PlanarNodeProbeResult["status"], string>> = {
  empty: "No node at this point",
  error: "Probe unavailable",
  loading: "Loading…",
  unsupported_operator: "Node unavailable for thickness averaging",
  unsupported_quantity: "This quantity has no node values",
};

/** Probe value with significant digits that survive SI scaling. */
export function formatProbeValue(value: number, unit: string): string {
  const magnitude = Math.abs(value);
  const text = magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e5)
    ? value.toExponential(4)
    : value.toPrecision(6).replace(/\.?0+$/, "");
  return unit ? `${text} ${unit}` : text;
}

/** Scalar, or a vector as three labelled components (never a raw tuple). */
function valueRows(
  value: { scalar: number | null; vector: readonly number[] | null },
  unit: string,
  prefix: string,
): { label: string; text: string }[] {
  if (value.vector) {
    return VECTOR_AXES.map((axis, index) => ({
      label: `${prefix}${axis}`,
      text: formatProbeValue(value.vector![index]!, unit),
    }));
  }
  return value.scalar === null ? [] : [{ label: `${prefix}value`, text: formatProbeValue(value.scalar, unit) }];
}

function entityName(kind: string): string {
  return kind === "fdm_cell_center" ? "cell" : "node";
}

interface ReadoutRow {
  label: string;
  text: string;
}

export function resultRows(
  result: PlanarNodeProbeResult,
  formatPosition: (uv: PlanarCursorUv) => string,
  formatLength: (metres: number) => string,
): ReadoutRow[] {
  const node = result.node;
  if (result.status === "ok" && node) {
    return [
      { label: "Position", text: formatPosition(node) },
      { label: "In-plane distance", text: formatLength(node.in_plane_distance_m) },
      ...(node.normal_offset_m !== 0
        ? [{ label: "Offset from plane", text: formatLength(node.normal_offset_m) }]
        : []),
      ...valueRows({ scalar: node.scalar ?? null, vector: node.vector ?? null }, result.unit, ""),
    ];
  }
  const rows: ReadoutRow[] = [{ label: "Status", text: STATUS_COPY[result.status] ?? result.status }];
  // Without a node the point value still answers "what is here".
  if (result.status !== "loading") rows.push(...valueRows(result.point, result.unit, "point "));
  return rows;
}

export function resultHeading(result: PlanarNodeProbeResult): string {
  return result.status === "ok" && result.node
    ? `${result.label} · ${entityName(result.node.kind)} ${result.node.node_id.toLocaleString("en-US")}`
    : result.label;
}

/** Plain-text copy of a readout, one layer per paragraph. */
export function planarNodeReadoutText(
  results: readonly PlanarNodeProbeResult[],
  formatPosition: (uv: PlanarCursorUv) => string,
  formatLength: (metres: number) => string,
): string {
  return results
    .map((result) => [
      resultHeading(result),
      ...resultRows(result, formatPosition, formatLength).map((row) => `${row.label}: ${row.text}`),
    ].join("\n"))
    .join("\n\n");
}
