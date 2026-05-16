import type { SlotId } from "../types";

/**
 * Ribbon tab identifiers — kernel-canonical set.
 * Modules reference these when contributing ribbon groups.
 */
export type RibbonTabId =
  | "home"
  | "view"
  | "definitions"
  | "geometry"
  | "materials"
  | "physics"
  | "mesh"
  | "study"
  | "results"
  | "automation";

export type PanelPosition = "left" | "right" | "bottom";

export interface LayoutState {
  /** Currently active ribbon tab */
  activeModuleTab: RibbonTabId;
  /** Panel visibility */
  panelVisible: Record<PanelPosition, boolean>;
  /** Which slot currently has keyboard/interaction focus */
  focusedSlot: SlotId | null;
}

export const DEFAULT_LAYOUT: LayoutState = {
  activeModuleTab: "home",
  panelVisible: { left: true, right: true, bottom: true },
  focusedSlot: null,
};
