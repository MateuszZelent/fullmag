import type { ReactNode } from "react";

import type { RibbonTabId } from "@/kernel/layout/layoutTypes";
import type { RibbonIconColor } from "./ribbonCommon";

// Re-export kernel-canonical type so module-local files can import from here.
export type { RibbonTabId };

export interface RibbonTabDef {
  id: RibbonTabId;
  label: string;
}

/**
 * Contextual tab of the analysis module that owns the selected Results node
 * (ADR 0054). It is ribbon-local state, never the persisted layout tab, so
 * the Results navigator stays in the left panel while it is shown.
 */
export const ANALYSIS_CONTEXT_TAB_ID = "analysis-context" as const;
export type RibbonStripTabId = RibbonTabId | typeof ANALYSIS_CONTEXT_TAB_ID;

export interface RibbonStripTabDef {
  contextual?: boolean;
  id: RibbonStripTabId;
  label: string;
}

export interface RibbonAction {
  type?: "checkbox" | "button";
  id: string;
  icon: ReactNode;
  label: string;
  tooltip?: string;
  shortcut?: string;
  disabled?: boolean;
  active?: boolean;
  activeCommandId?: string;
  accent?: boolean;
  /** Explicitly marks an unimplemented preview that production may omit. */
  preview?: boolean;
  /** Large is reserved for the primary action in a full-density group. */
  size?: "large" | "compact";
  status?: RibbonActionStatus;
  menu?: RibbonMenuNode[];
  commandId?: string;
  commandInput?: unknown;
  /** CSS color applied to the icon only (not label). Ignored when button is active. */
  iconColor?: RibbonIconColor;
  /**
   * When true the button behaves as a split-button: clicking the body runs the command
   * and clicking the chevron opens the dropdown. When false/undefined (default) the
   * entire button area opens the dropdown.
   */
  splitButton?: boolean;
}

export type RibbonActionStatus =
  | "pending"
  | "running"
  | "failed"
  | "stale"
  | "degraded";

export interface RibbonGroup {
  id: string;
  title: string;
  subtitle?: string;
  tone?: "authoring" | "compose" | "compute" | "selection" | "sync" | "neutral";
  actions: RibbonAction[];
}

export interface RibbonTabContent {
  tabId: RibbonTabId;
  groups: RibbonGroup[];
}

type RibbonStaticOrMappedInput<T> = unknown | ((value: T) => unknown);

export type RibbonMenuNode = (
  | {
      type: "label";
      id: string;
      label: string;
      badge?: string;
    }
  | {
      type: "separator";
      id: string;
    }
  | {
      type: "item";
      id: string;
      label: string;
      icon?: ReactNode;
      shortcut?: string;
      tooltip?: string;
      disabled?: boolean;
      commandId?: string;
      commandInput?: unknown;
    }
  | {
      type: "checkbox";
      id: string;
      label: string;
      checked: boolean;
      disabled?: boolean;
      tooltip?: string;
      commandId?: string;
      commandInput?: RibbonStaticOrMappedInput<boolean>;
    }
  | {
      type: "radio-group";
      id: string;
      label?: string;
      value: string;
      items: Array<{
        value: string;
        label: string;
        disabled?: boolean;
        preview?: boolean;
        tooltip?: string;
        commandId?: string;
        commandInput?: unknown;
      }>;
      disabled?: boolean;
      commandId?: string;
      commandInput?: RibbonStaticOrMappedInput<string>;
      tooltip?: string;
    }
  | {
      type: "status";
      id: string;
      label: string;
      value: string;
      tone?: "success" | "warning" | "danger" | "neutral";
    }
  | {
      type: "submenu";
      id: string;
      label: string;
      disabled?: boolean;
      nodes: RibbonMenuNode[];
      tooltip?: string;
    }
  | {
      type: "slider";
      id: string;
      label: string;
      value: number;
      min: number;
      max: number;
      step: number;
      unit?: string;
      disabled?: boolean;
      commandId?: string;
      commandInput?: RibbonStaticOrMappedInput<number>;
      tooltip?: string;
    }
  | {
      type: "color";
      id: string;
      label: string;
      value: string;
      disabled?: boolean;
      commandId?: string;
      commandInput?: RibbonStaticOrMappedInput<string>;
      tooltip?: string;
    }
  | {
      type: "text";
      id: string;
      label: string;
      value: string;
      placeholder?: string;
      disabled?: boolean;
      commandId?: string;
      commandInput?: RibbonStaticOrMappedInput<string>;
      tooltip?: string;
    }
) & { preview?: boolean };

export const RIBBON_TABS: RibbonTabDef[] = [
  { id: "home", label: "Workspace" },
  { id: "view", label: "View" },
  { id: "definitions", label: "Definitions" },
  { id: "geometry", label: "Geometry" },
  { id: "materials", label: "Materials" },
  { id: "physics", label: "Physics" },
  { id: "mesh", label: "Mesh" },
  { id: "study", label: "Study" },
  { id: "results", label: "Results" },
  { id: "automation", label: "Automation" },
];
