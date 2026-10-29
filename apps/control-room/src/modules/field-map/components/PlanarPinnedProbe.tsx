import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";

import type {
  ResolvedPlanarAxes,
  ResolvedPlanarProbeCoordinates,
} from "../model/planarAxisModel";

interface PlanarPinnedProbeProps {
  axisState: {
    axes: ResolvedPlanarAxes;
    coordinates: ResolvedPlanarProbeCoordinates;
  } | null;
  legendUnit: string;
  probe: {
    cell_id?: number | null;
    element_id?: number | null;
    occupancy: string;
    scalar?: number | null;
    u_m: number;
    v_m: number;
    vector?: number[] | null;
  };
  probeScale: number;
}

const OCCUPANCY_LABELS: Record<string, string> = {
  empty: "Outside the selected target",
  occupied: "Inside the target",
  outside: "Outside the sampled plane",
};

/** Format a probe value with significant digits that survive SI scaling. */
function formatProbeValue(value: number, unit: string): string {
  const magnitude = Math.abs(value);
  const text = magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e5)
    ? value.toExponential(4)
    : value.toPrecision(6).replace(/\.?0+$/, "");
  return unit ? `${text} ${unit}` : text;
}

export function PlanarPinnedProbe({
  axisState,
  legendUnit,
  probe,
  probeScale,
}: PlanarPinnedProbeProps) {
  const vector = probe.vector?.length === 3 ? probe.vector : null;
  const entity = probe.cell_id != null
    ? `cell ${probe.cell_id}`
    : probe.element_id != null
      ? `element ${probe.element_id}`
      : null;
  return (
    <table aria-label="Pinned planar probe" className="fm-field-map__pinned-probe">
      <caption>Pinned planar probe</caption>
      <tbody>
        <tr>
          <th scope="row">{axisState?.coordinates.horizontal.label ?? "x′"}</th>
          <td>{axisState
            ? formatValueWithUnit(
                axisState.coordinates.horizontal.valueMetres * axisState.axes.displayLengthUnit.scale,
                axisState.axes.displayLengthUnit.symbol,
              )
            : formatValueWithUnit(probe.u_m, "m")}</td>
        </tr>
        <tr>
          <th scope="row">{axisState?.coordinates.vertical.label ?? "y′"}</th>
          <td>{axisState
            ? formatValueWithUnit(
                axisState.coordinates.vertical.valueMetres * axisState.axes.displayLengthUnit.scale,
                axisState.axes.displayLengthUnit.symbol,
              )
            : formatValueWithUnit(probe.v_m, "m")}</td>
        </tr>
        <tr>
          <th scope="row">Value</th>
          <td>{probe.scalar == null ? "no sample" : formatProbeValue(probe.scalar * probeScale, legendUnit)}</td>
        </tr>
        {vector ? (
          <tr>
            <th scope="row">Vector</th>
            <td>({vector.map((component) => formatProbeValue(component * probeScale, "")).join(", ")}) {legendUnit}</td>
          </tr>
        ) : null}
        <tr>
          <th scope="row">Location</th>
          <td>{OCCUPANCY_LABELS[probe.occupancy] ?? probe.occupancy}{entity ? ` · ${entity}` : ""}</td>
        </tr>
      </tbody>
    </table>
  );
}
