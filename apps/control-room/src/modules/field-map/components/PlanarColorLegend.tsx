import { quantityDisplayName } from "@/kernel/api/quantityIds";
import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";
import { scalarColorPaletteGradientCss } from "@/shared/visualization/scalarColorPalette";

interface PlanarColorLegendProps {
  colormap: string;
  component: string;
  legendUnit: string;
  probeScale: number;
  quantityId: string;
  range: { max: number; min: number } | null;
  rangeState?: "current" | "pending" | "stale-compatible" | "unavailable";
}

export function PlanarColorLegend({
  colormap,
  component,
  legendUnit,
  probeScale,
  quantityId,
  range,
  rangeState,
}: PlanarColorLegendProps) {
  const rangeLabel = resolvePlanarColorRangeLabel(range, rangeState);
  return (
    <aside aria-label="Scalar color range" className="fm-field-map__colorbar">
      <div className="fm-field-map__colorbar-header">
        <div className="fm-field-map__colorbar-identity">
          <span className="fm-field-map__colorbar-context">2D field</span>
          <span className="fm-field-map__colorbar-quantity" title={quantityId}>
            {quantityDisplayName(quantityId)}
          </span>
          <span className="fm-field-map__colorbar-component">{component}</span>
        </div>
        <span className="fm-field-map__colorbar-unit" title="Display unit">
          {legendUnit || "unit unknown"}
        </span>
      </div>
      <div className="fm-field-map__colorbar-range">
        <span className="fm-field-map__colorbar-range-label">{rangeLabel}</span>
        <div className="fm-field-map__colorbar-row">
          <span className="fm-field-map__colorbar-limit fm-field-map__colorbar-limit--min">
            {range
              ? formatValueWithUnit(range.min * probeScale, legendUnit)
              : "Loading field range"}
          </span>
          <span
            aria-hidden="true"
            className="fm-field-map__colorbar-ramp"
            data-colormap={colormap}
            style={{ background: scalarColorPaletteGradientCss(colormap, "to right") }}
          />
          <span className="fm-field-map__colorbar-limit fm-field-map__colorbar-limit--max">
            {range
              ? formatValueWithUnit(range.max * probeScale, legendUnit)
              : "Loading field range"}
          </span>
        </div>
      </div>
    </aside>
  );
}

function resolvePlanarColorRangeLabel(
  range: { max: number; min: number } | null,
  rangeState: PlanarColorLegendProps["rangeState"],
): string {
  if (rangeState === "stale-compatible") {
    return range ? "Previous compatible range" : "Loading field range";
  }
  if (rangeState === "pending") return "Loading field range";
  if (rangeState === "unavailable") return "Field range unavailable";
  if (rangeState === "current") {
    return range ? "Rendered range" : "Field range unavailable";
  }
  return range ? "Rendered range" : "Loading field range";
}
