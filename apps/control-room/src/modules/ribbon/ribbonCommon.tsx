import { createElement } from "react";
import type { Play } from "lucide-react";
import type { RibbonMenuNode } from "./ribbonTypes";

export const I = 18; // icon size

export function icon(Icon: typeof Play, props?: Record<string, unknown>) {
  return createElement(Icon, { size: I, ...props });
}

export const C = {
  blue: "var(--fm-category-runtime)",
  lavender: "var(--fm-category-magnetization)",
  pink: "var(--fm-category-magnetization)",
  red: "var(--fm-danger)",
  peach: "var(--fm-category-energy)",
  yellow: "var(--fm-category-energy)",
  green: "var(--fm-category-solver)",
  teal: "var(--fm-accent-strong)",
  sky: "var(--fm-category-runtime)",
  sapphire: "var(--fm-category-runtime)",
} as const;

// Single canonical map from Tailwind-style color names to design tokens. The
// `C` shorthand above is the direct-token variant; this map is what the
// `text-<name>-<shade>` strings in ribbon definitions resolve through.
export const ICON_COLOR_ALIASES: Record<string, string> = {
  amber: "var(--fm-category-energy)",
  blue: "var(--fm-category-runtime)",
  cyan: "var(--fm-category-runtime)",
  emerald: "var(--fm-category-solver)",
  fuchsia: "var(--fm-category-magnetization)",
  green: "var(--fm-category-solver)",
  indigo: "var(--fm-category-runtime)",
  lime: "var(--fm-category-solver)",
  muted: "var(--fm-text-muted)",
  orange: "var(--fm-category-energy)",
  peach: "var(--fm-category-energy)",
  pink: "var(--fm-category-magnetization)",
  purple: "var(--fm-category-magnetization)",
  red: "var(--fm-danger)",
  rose: "var(--fm-category-magnetization)",
  sapphire: "var(--fm-category-runtime)",
  sky: "var(--fm-category-runtime)",
  slate: "var(--fm-text-muted)",
  stone: "var(--fm-text-muted)",
  teal: "var(--fm-accent-strong)",
  violet: "var(--fm-category-magnetization)",
  yellow: "var(--fm-category-energy)",
};

// Compile-time-checked icon color vocabulary. Unknown names become a type
// error instead of silently rendering with the default color.
export type RibbonIconColor =
  | `var(--${string})`
  | `text-${keyof typeof ICON_COLOR_ALIASES}-${number}`
  | "text-muted-foreground";

export function menu(
  id: string,
  label: string,
  entries: Array<string | [label: string, shortcut: string]>,
): RibbonMenuNode[] {
  return [
    { type: "label", id: `${id}:label`, label },
    ...entries.map((entry, index) => {
      const [entryLabel, shortcut] = Array.isArray(entry) ? entry : [entry, ""];
      return {
        type: "item" as const,
        id: `${id}:item:${index}`,
        label: entryLabel,
        preview: true,
        disabled: true,
        shortcut: shortcut || undefined,
      };
    }),
  ];
}

export function radioMenu(
  id: string,
  label: string,
  value: string,
  entries: Array<{ value: string; label: string } | [value: string, label: string]>,
): RibbonMenuNode[] {
  return [
    {
      type: "radio-group",
      id: `${id}:radio`,
      label,
      value,
      items: entries.map((entry) => {
        const [itemValue, itemLabel] = Array.isArray(entry)
          ? entry
          : [entry.value, entry.label];
        return {
          value: itemValue,
          label: itemLabel,
          preview: true,
          disabled: true,
        };
      }),
    },
  ];
}

export function separator(id: string): RibbonMenuNode {
  return { type: "separator", id };
}

export function statusMenu(
  id: string,
  label: string,
  value: string,
  tone: "success" | "warning" | "danger" | "neutral" = "neutral",
): RibbonMenuNode[] {
  return [{ type: "status", id, label, value, tone }];
}
