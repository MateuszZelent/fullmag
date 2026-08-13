import { createElement } from "react";
import type { Play } from "lucide-react";
import type { RibbonMenuNode } from "./ribbonTypes";

export const I = 18; // icon size

export function icon(Icon: typeof Play, props?: Record<string, unknown>) {
  return createElement(Icon, { size: I, ...props });
}

export const C = {
  blue: "var(--fm-accent)",
  lavender: "var(--fm-stale)",
  pink: "var(--fm-stale)",
  red: "var(--fm-danger)",
  peach: "var(--fm-degraded)",
  yellow: "var(--fm-warning)",
  green: "var(--fm-success)",
  teal: "var(--fm-accent-strong)",
  sky: "var(--fm-accent)",
  sapphire: "var(--fm-accent-strong)",
} as const;

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
