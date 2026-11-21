import { type Layout } from "react-resizable-panels";

const PANEL_LAYOUT_TOTAL = 100;

const PANEL_LAYOUT_TOTAL_TOLERANCE = 0.01;

export function normalizeStoredPanelLayout(
  storedLayout: unknown,
  panelCount: number | undefined,
): Layout | undefined {
  if (
    !storedLayout ||
    typeof storedLayout !== "object" ||
    Array.isArray(storedLayout)
  ) {
    return undefined;
  }

  const entries = Object.entries(storedLayout);
  if (entries.length === 0) {
    return undefined;
  }

  if (
    typeof panelCount === "number" &&
    Number.isInteger(panelCount) &&
    panelCount > 0 &&
    entries.length !== panelCount
  ) {
    return undefined;
  }

  const layout: Layout = {};
  for (const [panelId, value] of entries) {
    if (typeof value !== "number") {
      return undefined;
    }
    layout[panelId] = value;
  }

  const sizes = Object.values(layout);
  if (sizes.some((value) => !Number.isFinite(value) || value < 0)) {
    return undefined;
  }

  const total = sizes.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - PANEL_LAYOUT_TOTAL) > PANEL_LAYOUT_TOTAL_TOLERANCE) {
    return undefined;
  }

  return layout;
}
