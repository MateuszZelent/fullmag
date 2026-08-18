import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";
import { scalarColorPaletteGradientCss } from "@/shared/visualization/scalarColorPalette";

interface PlanarColorLegendProps {
  colormap: string;
  component: string;
  legendUnit: string;
  probeScale: number;
  quantityId: string;
  range: { max: number; min: number } | null;
}

export function PlanarColorLegend({
  colormap,
  component,
  legendUnit,
  probeScale,
  quantityId,
  range,
}: PlanarColorLegendProps) {
  return (
    <aside aria-label="Scalar color range" className="fm-field-map__colorbar">
      <div className="fm-field-map__colorbar-header">
        <div className="fm-field-map__colorbar-identity">
          <span className="fm-field-map__colorbar-context">2D field</span>
          <span className="fm-field-map__colorbar-quantity">{quantityId}</span>
          <span className="fm-field-map__colorbar-component">{component}</span>
        </div>
        <span className="fm-field-map__colorbar-unit" title="Display unit">
          {legendUnit}
        </span>
      </div>
      <div className="fm-field-map__colorbar-range">
        <span className="fm-field-map__colorbar-range-label">Rendered range</span>
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
