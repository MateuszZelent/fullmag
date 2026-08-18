"use client";

import { EyeOff } from "lucide-react";
import React, { type ReactNode } from "react";

import { nextVisualizationRadioValue } from "../panels/ObjectVisualizationPanelAccessibility";

export type VisualizationRenderModeValue =
  | "surface"
  | "surface+edges"
  | "wireframe"
  | "points"
  | "off";

const RENDER_MODE_LABELS: Record<
  VisualizationRenderModeValue,
  { label: string; subLabel?: string }
> = {
  surface: { label: "Shaded" },
  "surface+edges": { label: "Shaded + Wireframe", subLabel: "Wireframe" },
  wireframe: { label: "Wireframe" },
  points: { label: "Points" },
  off: { label: "Off" },
};

export interface VisualizationDisplayPassItem {
  ariaLabel?: string;
  disabled?: boolean;
  icon?: ReactNode;
  id: string;
  label: string;
  pressed: boolean;
  onToggle: () => void;
}

export function VisualizationDisplayPassesControl({
  items,
}: {
  items: readonly VisualizationDisplayPassItem[];
}) {
  return (
    <div className="fm-viz-layer-strip" data-slot="visualization-display-passes">
      {items.map((item) => (
        <button
          key={item.id}
          aria-label={item.ariaLabel ?? `Toggle ${item.label}`}
          aria-pressed={item.pressed}
          className={`fm-viz-layer-chip${item.pressed ? " fm-viz-layer-chip--on" : ""}`}
          disabled={item.disabled}
          type="button"
          onClick={item.onToggle}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function VisualizationRenderModeControl({
  disabled,
  options,
  value,
  onValueChange,
}: {
  disabled: boolean;
  options: readonly VisualizationRenderModeValue[];
  value: VisualizationRenderModeValue;
  onValueChange: (value: VisualizationRenderModeValue) => void;
}) {
  const activeIndex = options.indexOf(value);
  const tabStopIndex = activeIndex >= 0 ? activeIndex : 0;
  const radioRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  return (
    <div className="grid min-w-0 gap-1.5">
      <span className="fm-viz-render-mode-label">Render Mode</span>
      <div
        aria-label="Render mode"
        className="fm-viz-render-mode-grid"
        role="radiogroup"
      >
        {options.map((option, index) => {
          const label = RENDER_MODE_LABELS[option];
          const active = value === option;
          return (
            <button
              key={option}
              aria-checked={active}
              aria-label={label.label}
              className={`fm-viz-render-mode-tile ${active ? "fm-viz-render-mode-tile--active" : ""}`}
              disabled={disabled}
              ref={(element) => {
                radioRefs.current[index] = element;
              }}
              role="radio"
              tabIndex={index === tabStopIndex ? 0 : -1}
              type="button"
              onClick={() => onValueChange(option)}
              onKeyDown={(event) => {
                const next = nextVisualizationRadioValue(options, option, event.key);
                if (next === option) return;
                event.preventDefault();
                const nextIndex = options.indexOf(next);
                radioRefs.current[nextIndex]?.focus();
                onValueChange(next);
              }}
            >
              <span className="fm-viz-render-mode-tile__icon" aria-hidden="true">
                <VisualizationRenderModeIcon active={active} mode={option} />
              </span>
              <span className="fm-viz-render-mode-tile__label">
                {option === "surface+edges" ? "Shaded +" : label.label}
                {label.subLabel ? (
                  <span className="fm-viz-render-mode-tile__sub-label">
                    {label.subLabel}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function VisualizationRenderModeIcon({
  active,
  mode,
}: {
  active: boolean;
  mode: VisualizationRenderModeValue;
}) {
  if (mode === "off") return <EyeOff size={20} strokeWidth={1.5} />;
  if (mode === "points") {
    return (
      <svg fill="none" height="20" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" width="20">
        <circle cx="12" cy="12" fill="currentColor" r="1.5" />
        <circle cx="7" cy="9" fill="currentColor" r="1.5" />
        <circle cx="17" cy="9" fill="currentColor" r="1.5" />
        <circle cx="7" cy="15" fill="currentColor" r="1.5" />
        <circle cx="17" cy="15" fill="currentColor" r="1.5" />
      </svg>
    );
  }
  return (
    <svg fill="none" height="20" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24" width="20">
      <path
        d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
        fill={active && mode !== "wireframe" ? "currentColor" : "none"}
        fillOpacity={active && mode !== "wireframe" ? "0.15" : "0"}
      />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" x2="12" y1="22.08" y2="12" />
      {mode !== "surface" ? <polyline points="7 9.5 12 12 17 9.5" /> : null}
    </svg>
  );
}
