import type { ReactNode } from "react";

import type { RibbonTabId } from "@/kernel/layout/layoutTypes";

// Re-export kernel-canonical type so module-local files can import from here.
export type { RibbonTabId };

export interface RibbonTabDef {
  id: RibbonTabId;
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
  menu?: RibbonMenuNode[];
  commandId?: string;
  commandInput?: unknown;
  /** CSS color applied to the icon only (not label). Ignored when button is active. */
  iconColor?: string;
  /**
   * When true the button behaves as a split-button: clicking the body runs the command
   * and clicking the chevron opens the dropdown. When false/undefined (default) the
   * entire button area opens the dropdown.
   */
  splitButton?: boolean;
}

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

export type RibbonMenuNode =
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
        commandId?: string;
        commandInput?: unknown;
      }>;
      disabled?: boolean;
      commandId?: string;
      commandInput?: RibbonStaticOrMappedInput<string>;
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
    }
  | {
      type: "color";
      id: string;
      label: string;
      value: string;
      disabled?: boolean;
      commandId?: string;
      commandInput?: RibbonStaticOrMappedInput<string>;
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
    };

export const RIBBON_TABS: RibbonTabDef[] = [
  { id: "home", label: "Home" },
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
