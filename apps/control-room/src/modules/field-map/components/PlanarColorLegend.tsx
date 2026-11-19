import { useEffect, useRef } from "react";

import { quantityDisplayName } from "@/kernel/api/quantityIds";
import { directionHslSrgb, isDirectionColormap } from "@/shared/visualization/directionColor";
import { formatValueWithUnit } from "@/shared/domain/physics/displayUnits";
import { scalarColorPaletteGradientCss } from "@/shared/visualization/scalarColorPalette";

interface PlanarColorLegendProps {
  /** One compact card of a layer stack (plan §2.1 C). */
  compact?: boolean;
  targetLabel?: string;
  colormap: string;
  component: string;
  legendUnit: string;
  probeScale: number;
  quantityId: string;
  range: { max: number; min: number } | null;
  rangeState?: "current" | "pending" | "stale-compatible" | "unavailable";
}

export function PlanarColorLegend({
  compact = false,
  targetLabel,
  colormap,
  component,
  legendUnit,
  probeScale,
  quantityId,
  range,
  rangeState,
}: PlanarColorLegendProps) {
  if (isDirectionColormap(colormap)) {
    return <PlanarDirectionLegend compact={compact} quantityId={quantityId} targetLabel={targetLabel} />;
  }
  const rangeLabel = resolvePlanarColorRangeLabel(range, rangeState);
  return (
    <aside
      aria-label={targetLabel ? `${targetLabel} color range` : "Scalar color range"}
      className={`fm-field-map__colorbar${compact ? " fm-field-map__colorbar--compact" : ""}`}
    >
      <div className="fm-field-map__colorbar-header">
        <div className="fm-field-map__colorbar-identity">
          <span className="fm-field-map__colorbar-context">{targetLabel ?? "2D field"}</span>
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

const DIRECTION_SWATCH_PX = 56;

function DirectionHemisphere({ sign, label }: { sign: 1 | -1; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const size = DIRECTION_SWATCH_PX * 2;
    canvas.width = size;
    canvas.height = size;
    const image = context.createImageData(size, size);
    const half = size / 2;
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        const x = (column + 0.5 - half) / half;
        const y = (half - row - 0.5) / half;
        const radius = Math.hypot(x, y);
        if (radius > 1) continue;
        const [red, green, blue] = directionHslSrgb(x, y, sign * Math.sqrt(1 - radius * radius));
        const offset = (row * size + column) * 4;
        image.data[offset] = Math.round(red * 255);
        image.data[offset + 1] = Math.round(green * 255);
        image.data[offset + 2] = Math.round(blue * 255);
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [sign]);
  return (
    <figure className="fm-field-map__direction-hemisphere">
      <canvas
        aria-hidden="true"
        className="fm-field-map__direction-swatch"
        ref={canvasRef}
      />
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/**
 * Legend of the mumax3 direction wheel: hue is the in-plane angle in the world
 * XY plane (+X red), lightness the z component (+Z white, -Z black).
 */
function PlanarDirectionLegend({ compact, quantityId, targetLabel }: { compact: boolean; quantityId: string; targetLabel?: string }) {
  const name = quantityDisplayName(quantityId);
  return (
    <aside
      aria-label={`${name} direction colours: hue is the in-plane angle in the XY plane, lightness is the z component`}
      className={`fm-field-map__colorbar fm-field-map__colorbar--direction${compact ? " fm-field-map__colorbar--compact" : ""}`}
    >
      <div className="fm-field-map__colorbar-header">
        <div className="fm-field-map__colorbar-identity">
          <span className="fm-field-map__colorbar-context">{targetLabel ?? "2D field"}</span>
          <span className="fm-field-map__colorbar-quantity" title={quantityId}>{name}</span>
          <span className="fm-field-map__colorbar-component">direction</span>
        </div>
        <span className="fm-field-map__colorbar-unit">unit vector</span>
      </div>
      <div className="fm-field-map__direction-legend">
        <DirectionHemisphere label="z > 0" sign={1} />
        <DirectionHemisphere label="z < 0" sign={-1} />
        {compact ? null : (
          <p className="fm-field-map__direction-note">
            Hue: angle in XY (+X red). Lightness: z (+Z white, −Z black). Magnitude is not shown; use |v|.
          </p>
        )}
      </div>
    </aside>
  );
}

export interface PlanarLayerLegendEntry {
  id: string;
  colormap: string;
  component: string;
  legendUnit: string;
  probeScale: number;
  quantityId: string;
  range: { max: number; min: number } | null;
  targetLabel: string;
}

/**
 * Legend of the field layer stack: one compact card per drawn layer, in list
 * order (top layer first). The toolbar legend toggle
 * (`planar.viewport_colorbar_visible`) hides the whole stack.
 */
export function PlanarLayerLegendList({
  layers,
  rangeState,
  visible,
}: {
  layers: readonly PlanarLayerLegendEntry[];
  rangeState?: PlanarColorLegendProps["rangeState"];
  visible: boolean;
}) {
  if (!visible || layers.length === 0) return null;
  return (
    <div aria-label="Field layer legends" className="fm-field-map__layer-legends" role="group">
      {layers.map((layer) => (
        <PlanarColorLegend
          key={layer.id}
          compact
          colormap={layer.colormap}
          component={layer.component}
          legendUnit={layer.legendUnit}
          probeScale={layer.probeScale}
          quantityId={layer.quantityId}
          range={layer.range}
          rangeState={rangeState}
          targetLabel={layer.targetLabel}
        />
      ))}
    </div>
  );
}
