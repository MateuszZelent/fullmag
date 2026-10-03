import { groupByRecency, type RecentGroupId } from "../model/recentIndex";
import type { RecentEntry } from "../model/types";

export type RecentListItem =
  | {
      readonly kind: "header";
      readonly id: RecentGroupId;
      readonly label: string;
      readonly count: number;
    }
  | { readonly kind: "entry"; readonly entry: RecentEntry; readonly ordinal: number };

/** Row count above which the list virtualises; below it plain DOM is cheaper. */
export const VIRTUALISE_ABOVE = 40;

/**
 * Flatten date groups into one list, entry ordinals numbering only the
 * selectable rows so keyboard navigation can ignore headers.
 */
export function buildListItems(
  entries: readonly RecentEntry[],
  grouped: boolean,
  now: Date = new Date(),
): RecentListItem[] {
  if (!grouped) {
    return entries.map((entry, ordinal) => ({ kind: "entry", entry, ordinal }));
  }
  const items: RecentListItem[] = [];
  let ordinal = 0;
  for (const group of groupByRecency(entries, now)) {
    items.push({ kind: "header", id: group.id, label: group.label, count: group.entries.length });
    for (const entry of group.entries) items.push({ kind: "entry", entry, ordinal: ordinal++ });
  }
  return items;
}
