export type PanelMode = "docked" | "floating" | "maximized";
export interface Geometry { x: number; y: number; width: number; height: number }
export const INITIAL_GEOMETRY: Geometry = { x: 96, y: 144, width: 416, height: 560 };

export function panelFrameStorageKey(id: string): string {
  return `fullmag.workspace.panel.${id}.v2`;
}

export function constrain(g: Geometry): Geometry {
  const width = Math.max(240, Math.min(g.width, window.innerWidth - 16));
  const height = Math.max(180, Math.min(g.height, window.innerHeight - 16));
  return { width, height, x: Math.max(8, Math.min(g.x, window.innerWidth - width - 8)), y: Math.max(8, Math.min(g.y, window.innerHeight - height - 8)) };
}

export function readPanelFramePreference(id: string): { mode: PanelMode; geometry: Geometry } {
  const fallback: { mode: PanelMode; geometry: Geometry } = { mode: "docked", geometry: INITIAL_GEOMETRY };
  if (typeof window === "undefined") return fallback;
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(panelFrameStorageKey(id)) ?? "null");
    if (raw && typeof raw === "object") {
      const value = raw as { mode?: unknown; geometry?: Partial<Geometry> };
      const mode: PanelMode = value.mode === "floating" || value.mode === "maximized" ? value.mode : "docked";
      const geometry = value.geometry;
      return {
        mode,
        geometry: geometry && [geometry.x, geometry.y, geometry.width, geometry.height].every(
          coordinate => typeof coordinate === "number" && Number.isFinite(coordinate),
        ) ? constrain(geometry as Geometry) : INITIAL_GEOMETRY,
      };
    }
  } catch { /* Invalid layout preferences use the default frame. */ }
  return fallback;
}
