import type { PlanarFieldProfileResource } from "@/kernel/api/apiTypes";
import type { ChartRenderModel, ChartRenderPoint, ChartRenderSeries } from "@/shared/analysis-charts/chartRenderer";
import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";

export interface PlanarProfileDisplay {
  lengthScale: number;
  lengthUnit: string;
  legendUnit: string;
  probeScale: number;
}

const VECTOR_COMPONENTS = ["x", "y", "z"] as const;

/**
 * Chart model of a line profile: the scalar of the selected component and, for
 * vector quantities, its three world components against the arc length. Points
 * without a value (outside the frame or the target) break the line.
 */
export function planarProfileChartModel(
  profile: PlanarFieldProfileResource,
  display: PlanarProfileDisplay,
  quantityLabel: string,
): ChartRenderModel {
  const series: ChartRenderSeries[] = [];
  const line = (
    id: string,
    label: string,
    value: (point: PlanarFieldProfileResource["points"][number]) => number | null | undefined,
  ): ChartRenderSeries => {
    const points: ChartRenderPoint[] = [];
    let gap = false;
    profile.points.forEach((point, rowIndex) => {
      const y = value(point);
      if (y === null || y === undefined || !Number.isFinite(y)) {
        gap = true;
        return;
      }
      points.push({
        breakBefore: gap && points.length > 0,
        rowIndex,
        x: point.s_m * display.lengthScale,
        y: y * display.probeScale,
      });
      gap = false;
    });
    return { id, kind: "line", label, points, unit: display.legendUnit, yAxis: 0 };
  };
  series.push(line("scalar", `${quantityLabel} (${profile.component})`, (point) => point.scalar));
  if (profile.points.some((point) => point.vector)) {
    VECTOR_COMPONENTS.forEach((axis, index) => {
      series.push(line(axis, `${quantityLabel} ${axis}`, (point) => point.vector?.[index]));
    });
  }
  const valued = series[0]!.points.length;
  return {
    ariaLabel: `Line profile of ${quantityLabel} along ${formatValueWithUnit(
      profile.length_m * display.lengthScale,
      display.lengthUnit,
    )}`,
    key: `planar-profile:${profile.sample_token}:${profile.u0_m}:${profile.v0_m}:${profile.u1_m}:${profile.v1_m}`,
    provenance: {
      dataRevision: profile.sample_token,
      decimation: "none",
      query: `u0=${profile.u0_m},v0=${profile.v0_m},u1=${profile.u1_m},v1=${profile.v1_m}`,
      resourceKey: profile.sample_token,
    },
    series,
    status: valued > 0 ? "ready" : "empty",
    statusMessage: valued > 0 ? undefined : "The segment does not cross the sampled target.",
    xAxis: { label: "Arc length s", unit: display.lengthUnit },
    yAxes: [{ label: quantityLabel, unit: display.legendUnit }],
  };
}
