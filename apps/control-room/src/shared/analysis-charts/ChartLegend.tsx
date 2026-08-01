"use client";

import { type KeyboardEvent } from "react";

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
  /** Whether this series is currently hidden */
  hidden: boolean;
  /** Whether another series is soloed (making this one hidden unless it is the solo) */
  soloed: boolean;
}

interface ChartLegendProps {
  items: readonly ChartLegendItem[];
  /**
   * Called when user clicks/keys a legend item.
   * Caller decides the toggle semantics (hide vs. solo).
   */
  onToggleVisibility?: (id: string) => void;
  /** Called when user activates Solo action (Shift+click or dedicated button) */
  onSolo?: (id: string | null) => void;
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
 * - Click / Enter / Space: toggle series visibility (hide/show).
 * - Shift+Click / Shift+Enter: solo this series (hide all others).
 * - Second Shift+Click on already-soloed item: clear solo (show all).
 *
 * No fetches are triggered by any of these actions.
 */
export function ChartLegend({
  items,
  onToggleVisibility,
  onSolo,
  ariaLabel = "Chart series",
}: ChartLegendProps) {
  if (items.length === 0) return null;

  const visibleItems = items.filter((item) => !item.hidden);
  const soloedId = items.length > 1 && visibleItems.length === 1 ? visibleItems[0]?.id ?? null : null;

  function handleClick(
    event: React.MouseEvent<HTMLButtonElement>,
    item: ChartLegendItem,
  ) {
    if (event.shiftKey) {
      // Solo semantics: toggle off if already soloed, else solo target item
      onSolo?.(soloedId === item.id ? null : item.id);
    } else {
      onToggleVisibility?.(item.id);
    }
  }

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    item: ChartLegendItem,
  ) {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        onSolo?.(soloedId === item.id ? null : item.id);
      } else {
        onToggleVisibility?.(item.id);
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
        const isHidden = item.hidden;
        const colorName = item.colorName || chartColorNameForIndex(item.colorIndex);
        return (
          <button
            aria-label={`${item.label}, unit ${item.unit || "dimensionless"}, latest ${item.latestValue}. ${isHidden ? "Hidden" : "Visible"}. Press Shift to solo.`}
            aria-pressed={!isHidden}
            className={[
              "fm-chart-legend__item",
              isHidden ? "fm-chart-legend__item--hidden" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            disabled={!onToggleVisibility && !onSolo}
            key={item.id}
            onClick={(e) => handleClick(e, item)}
            onKeyDown={(e) => handleKeyDown(e, item)}
            title={`${item.label}${item.unit ? ` · ${chartLegendUnitLabel(item.unit)}` : ""} — latest: ${item.latestValue}${onToggleVisibility || onSolo ? ". Click to hide/show. Shift+click to solo." : "."}`}
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
