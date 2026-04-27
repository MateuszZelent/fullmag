import type { ReactNode } from "react";

export type RibbonNodeState =
  | "default"
  | "active"
  | "mixed"
  | "loading"
  | "warning"
  | "unavailable";

export type RibbonMenuNodeBase = {
  id: string;
  hidden?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  state?: RibbonNodeState;
  description?: string | null;
  testId?: string;
};

export type RibbonMenuItemNode = RibbonMenuNodeBase & {
  type: "item";
  label: string;
  icon?: ReactNode;
  action?: () => void;
  shortcut?: string;
};

export type RibbonMenuCheckboxNode = RibbonMenuNodeBase & {
  type: "checkbox";
  label: string;
  checked: boolean | "indeterminate";
  onCheckedChange: (value: boolean) => void;
};

export type RibbonMenuRadioGroupNode = RibbonMenuNodeBase & {
  type: "radio-group";
  label?: string;
  value: string;
  onValueChange: (value: string) => void;
  items: Array<{
    value: string;
    label: string;
    disabled?: boolean;
    disabledReason?: string | null;
    description?: string | null;
  }>;
};

export type RibbonMenuSliderNode = RibbonMenuNodeBase & {
  type: "slider";
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  formatValue?: (value: number) => string;
  onValueChange: (value: number) => void;
  onValueCommit?: (value: number) => void;
};

export type RibbonMenuColorNode = RibbonMenuNodeBase & {
  type: "color";
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  onValueCommit?: (value: string) => void;
};

export type RibbonMenuSubmenuNode = RibbonMenuNodeBase & {
  type: "submenu";
  label: string;
  nodes: RibbonMenuNode[];
};

export type RibbonMenuLabelNode = RibbonMenuNodeBase & {
  type: "label";
  label: string;
  badge?: string;
};

export type RibbonMenuSeparatorNode = RibbonMenuNodeBase & {
  type: "separator";
};

export type RibbonMenuStatusNode = RibbonMenuNodeBase & {
  type: "status";
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning" | "danger";
};

export type RibbonMenuNode =
  | RibbonMenuItemNode
  | RibbonMenuCheckboxNode
  | RibbonMenuRadioGroupNode
  | RibbonMenuSliderNode
  | RibbonMenuColorNode
  | RibbonMenuSubmenuNode
  | RibbonMenuLabelNode
  | RibbonMenuSeparatorNode
  | RibbonMenuStatusNode;
