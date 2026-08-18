import { useMemo } from "react";

import {
  resolvePlanarAxes,
  type PlanarAxisFrame,
  type PlanarAxisTick,
} from "../model/planarAxisModel";

interface PlanarAxesProps {
  bounds: readonly [number, number, number, number];
  frame: PlanarAxisFrame;
  plotSize: { height: number; width: number };
  viewport: readonly [number, number, number, number];
}

export function PlanarAxes({
  bounds,
  frame,
  plotSize,
  viewport,
}: PlanarAxesProps) {
  const axes = useMemo(
    () => resolvePlanarAxes(
      frame,
      bounds,
      viewport,
      plotSize.width,
      plotSize.height,
    ),
    [bounds, frame, plotSize.height, plotSize.width, viewport],
  );
  const unit = axes.displayLengthUnit.symbol;

  return (
    <div
      className="fm-field-map__axes"
      data-planar-axis-preset={axes.preset}
      data-planar-plot-height={plotSize.height}
      data-planar-plot-width={plotSize.width}
    >
      <div
        aria-label={`Horizontal ${axes.horizontal.label} axis`}
        className="fm-field-map__axis fm-field-map__axis--horizontal"
        role="group"
      >
        <span className="fm-field-map__axis-title">
          {axes.horizontal.label} ({unit})
        </span>
        <div aria-hidden="true" className="fm-field-map__axis-track">
          {axes.horizontal.ticks.map((tick) => (
            <AxisTick
              key={tickKey(tick)}
              orientation="horizontal"
              tick={tick}
            />
          ))}
        </div>
      </div>
      <div
        aria-label={`Vertical ${axes.vertical.label} axis`}
        className="fm-field-map__axis fm-field-map__axis--vertical"
        role="group"
      >
        <span className="fm-field-map__axis-title">
          {axes.vertical.label} ({unit})
        </span>
        <div aria-hidden="true" className="fm-field-map__axis-track">
          {axes.vertical.ticks.map((tick) => (
            <AxisTick
              key={tickKey(tick)}
              orientation="vertical"
              tick={tick}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function AxisTick({
  orientation,
  tick,
}: {
  orientation: "horizontal" | "vertical";
  tick: PlanarAxisTick;
}) {
  return (
    <span
      className={`fm-field-map__axis-tick fm-field-map__axis-tick--${orientation}`}
      data-planar-axis-tick={tick.value}
      data-planar-axis-zero={tick.zero ? "true" : undefined}
      style={orientation === "horizontal"
        ? { left: tick.positionPx }
        : { bottom: tick.positionPx }}
    >
      <span className="fm-field-map__axis-mark" />
      <span className="fm-field-map__axis-value">{tick.label}</span>
    </span>
  );
}

function tickKey(tick: PlanarAxisTick): string {
  return `${tick.positionPx}:${tick.value}`;
}
