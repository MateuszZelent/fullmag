import type { MeshPolicyDiffRow } from "@/shared/domain/mesh/meshPolicyDiff";

function formatLength(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unset";
  const abs = Math.abs(value);
  if (abs >= 1e-3) return `${(value * 1e3).toPrecision(4)} mm`;
  if (abs >= 1e-6) return `${(value * 1e6).toPrecision(4)} um`;
  if (abs >= 1e-9) return `${(value * 1e9).toPrecision(4)} nm`;
  return `${value.toExponential(3)} m`;
}

export interface MeshBuildParameterDiffProps {
  rows: readonly MeshPolicyDiffRow[];
}

const PARAM_LABELS: Record<string, string> = {
  maximum_element_size: "Max element size",
  minimum_element_size: "Min element size",
  maximum_element_growth_rate: "Growth rate",
  curvature_factor: "Curvature factor",
  mesh_strategy: "Mesh strategy",
  algorithm_2d: "Algorithm 2D",
  algorithm_3d: "Algorithm 3D",
  smoothing_steps: "Smoothing steps",
  order: "Order",
  edge_maximum_element_size: "Edge max size",
  corner_maximum_element_size: "Corner max size",
  transition_distance: "Transition distance",
  boundary_layer_count: "Boundary layer count",
  through_thickness_elements: "Through-thickness elements",
  size_preset: "Size preset",
  airbox_hmax: "Max element size (Hmax)",
  airbox_hmin: "Min element size (Hmin)",
};

function formatPolicyValue(path: string, value: string): string {
  if (value === "unset" || value === "null" || value === "MISSING" || !value) return "unset";
  const num = parseFloat(value);
  if (!isNaN(num)) {
    const isLength =
      path.includes("size") ||
      path.includes("distance") ||
      path.includes("hmax") ||
      path.includes("hmin") ||
      path.includes("thickness") ||
      path.includes("extent");
    if (isLength) {
      return formatLength(num);
    }
    const isGrowth = path.includes("growth_rate") || path.includes("stretching");
    if (isGrowth) {
      return `${num.toFixed(2)}x`;
    }
    if (path.includes("algorithm")) {
      if (path.includes("2d")) {
        if (num === 6) return "Frontal-Delaunay (6)";
        if (num === 1) return "MeshAdapt (1)";
        if (num === 2) return "Automatic (2)";
        if (num === 5) return "Delaunay (5)";
        if (num === 8) return "Frontal-Delaunay for Quads (8)";
      }
      if (path.includes("3d")) {
        if (num === 1) return "Delaunay (1)";
        if (num === 4) return "Frontal (4)";
        if (num === 7) return "MMG3D (7)";
        if (num === 9) return "HXT (9)";
      }
    }
  }
  return value;
}

export function MeshBuildParameterDiff({ rows }: MeshBuildParameterDiffProps) {
  if (rows.length === 0) {
    return (
      <section className="fm-mesh-build-confirm__section" aria-label="Mesh parameter changes">
        <h3 className="fm-mesh-build-confirm__section-title">Parameter Changes</h3>
        <p className="fm-mesh-build-confirm__empty">No pending policy changes.</p>
      </section>
    );
  }

  return (
    <section className="fm-mesh-build-confirm__section" aria-label="Mesh parameter changes">
      <h3 className="fm-mesh-build-confirm__section-title">Parameter Changes</h3>
      <table className="fm-mesh-build-confirm__diff">
        <thead>
          <tr className="fm-mesh-build-confirm__diff-row fm-mesh-build-confirm__diff-row--header">
            <th scope="col">Scope</th>
            <th scope="col">Parameter</th>
            <th scope="col">Current</th>
            <th scope="col">New</th>
            <th scope="col">Last realized</th>
            <th scope="col">Impact</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              className="fm-mesh-build-confirm__diff-row"
              data-state={row.state}
              key={`${row.scope}:${row.path}`}
            >
              <td className="fm-mesh-build-confirm__cell fm-mesh-build-confirm__cell--scope">
                {row.scope}
              </td>
              <td
                className="fm-mesh-build-confirm__cell fm-mesh-build-confirm__cell--label font-bold"
                data-path={row.path}
              >
                {PARAM_LABELS[row.path] ?? row.label}
              </td>
              <td className="fm-mesh-build-confirm__cell fm-mesh-build-confirm__cell--current">
                {formatPolicyValue(row.path, row.currentValue)}
              </td>
              <td className="fm-mesh-build-confirm__cell fm-mesh-build-confirm__cell--draft font-bold">
                {formatPolicyValue(row.path, row.draftValue)}
              </td>
              <td className="fm-mesh-build-confirm__cell fm-mesh-build-confirm__cell--realized">
                {formatPolicyValue(row.path, row.realizedValue)}
              </td>
              <td className="fm-mesh-build-confirm__cell fm-mesh-build-confirm__cell--impact">
                {row.impact}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
