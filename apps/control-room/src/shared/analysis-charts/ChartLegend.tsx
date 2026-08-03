"use client";

import { type KeyboardEvent } from "react";

import {
  selectAllSeriesIds,
  soloSeriesId,
  toggleSelectedSeriesId,
} from "./chartSeriesSelection";

export interface ChartLegendItem {
  /** Stable series ID */
  id: string;
  /** Display label */
  label: string;
  /** Physical unit */
  unit: string;
  /** Latest formatted value (from data) */
  latestValue: string;
  /** Color token name, e.g. "blue", "green" — maps to --fm-chart-{name} */
  colorName: string;
  /** Index in the palette (for fallback modulo) */
  colorIndex: number;
}

interface ChartLegendProps {
  items: readonly ChartLegendItem[];
  selectedSeriesIds: readonly string[];
  onSelectedSeriesIdsChange?: (selectedSeriesIds: string[]) => void;
  /** Accessible label for the legend region */
  ariaLabel?: string;
}

const COLOR_NAMES = [
  "blue",
  "green",
  "yellow",
  "red",
  "mauve",
  "peach",
  "teal",
  "sky",
  "pink",
  "lavender",
  "flamingo",
  "rosewater",
] as const;

function chartLegendUnitLabel(unit: string): string {
  const normalized = unit.trim();
  return normalized === "dimensionless" ? "1" : normalized;
}

/** Derives a color name from a 0-based index, cycling through the 12-token palette. */
export function chartColorNameForIndex(index: number): string {
  return COLOR_NAMES[index % COLOR_NAMES.length] ?? "blue";
}

/**
 * ChartLegend — shared scientific series legend.
 *
 * Interactions:
 * - Click / Enter / Space: toggle series selection.
 * - Shift+Click / Shift+Enter: solo this series; repeat to show all.
 *
 * No fetches are triggered by any of these actions.
 */
export function ChartLegend({
  items,
  onSelectedSeriesIdsChange,
  selectedSeriesIds,
  ariaLabel = "Chart series",
}: ChartLegendProps) {
  if (items.length === 0) return null;

  const selected = new Set(selectedSeriesIds);
  const availableIds = items.map((item) => item.id);

  function handleClick(
    event: React.MouseEvent<HTMLButtonElement>,
    item: ChartLegendItem,
  ) {
    if (event.shiftKey) {
      onSelectedSeriesIdsChange?.(
        selected.size === 1 && selected.has(item.id)
          ? selectAllSeriesIds(availableIds)
          : soloSeriesId(item.id),
      );
    } else {
      onSelectedSeriesIdsChange?.(
        toggleSelectedSeriesId(selectedSeriesIds, item.id, !selected.has(item.id)),
      );
    }
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    item: ChartLegendItem,
  ) {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        onSelectedSeriesIdsChange?.(
          selected.size === 1 && selected.has(item.id)
            ? selectAllSeriesIds(availableIds)
            : soloSeriesId(item.id),
        );
      } else {
        onSelectedSeriesIdsChange?.(
          toggleSelectedSeriesId(selectedSeriesIds, item.id, !selected.has(item.id)),
        );
      }
    }
  }

  return (
    <div
      aria-label={ariaLabel}
      className="fm-chart-legend"
      role="group"
    >
      {items.map((item) => {
        const isSelected = selected.has(item.id);
        const colorName = item.colorName || chartColorNameForIndex(item.colorIndex);
        return (
          <button
            aria-label={`${item.label}, unit ${item.unit || "dimensionless"}, latest ${item.latestValue}. ${isSelected ? "Selected" : "Hidden"}. Press Shift to solo.`}
            aria-pressed={isSelected}
            className={[
              "fm-chart-legend__item",
              isSelected ? "" : "fm-chart-legend__item--hidden",
            ]
              .filter(Boolean)
              .join(" ")}
            disabled={!onSelectedSeriesIdsChange}
            key={item.id}
            onClick={(e) => handleClick(e, item)}
            onKeyDown={(e) => handleKeyDown(e, item)}
            title={`${item.label}${item.unit ? ` · ${chartLegendUnitLabel(item.unit)}` : ""} — latest: ${item.latestValue}${onSelectedSeriesIdsChange ? ". Click to select/hide. Shift+click to solo." : "."}`}
            type="button"
          >
            <span
              aria-hidden="true"
              className={`fm-chart-legend__swatch fm-chart-legend__swatch--${colorName}`}
            />
            <span className="fm-chart-legend__identity">
              <span className="fm-chart-legend__label">{item.label}</span>
              {item.unit ? (
                <span
                  className="fm-chart-legend__unit"
                  data-slot="chart-legend-unit"
                >
                  {chartLegendUnitLabel(item.unit)}
                </span>
              ) : null}
            </span>
            <span
              aria-label={`latest value: ${item.latestValue}`}
              className="fm-chart-legend__latest"
              data-slot="chart-legend-reading"
              title={`Latest: ${item.latestValue} ${item.unit}`}
            >
              {item.latestValue}
            </span>
          </button>
        );
      })}
    </div>
  );
}
