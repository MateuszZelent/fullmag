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
    occupancy: string;
    scalar?: number | null;
    u_m: number;
    v_m: number;
  };
  probeScale: number;
}

export function PlanarPinnedProbe({
  axisState,
  legendUnit,
  probe,
  probeScale,
}: PlanarPinnedProbeProps) {
  return (
    <table className="fm-field-map__pinned-probe">
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
          <td>{probe.scalar == null ? "undefined" : probe.scalar * probeScale} {legendUnit}</td>
        </tr>
        <tr><th scope="row">Occupancy</th><td>{probe.occupancy}</td></tr>
      </tbody>
    </table>
  );
}
