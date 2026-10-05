import { groupByRecency, type RecentGroupId } from "../model/recentIndex";
import { rowRecency, type RecentRow } from "../model/recentRows";

export type RecentListItem =
  | {
      readonly kind: "header";
      readonly id: RecentGroupId;
      readonly label: string;
      readonly count: number;
    }
  | { readonly kind: "row"; readonly row: RecentRow; readonly ordinal: number };

/** Row count above which the list virtualises; below it plain DOM is cheaper. */
export const VIRTUALISE_ABOVE = 40;

/**
 * Flatten date groups into one list, row ordinals numbering only the
 * selectable rows so keyboard navigation can ignore headers.
 */
export function buildListItems(
  rows: readonly RecentRow[],
  grouped: boolean,
  now: Date = new Date(),
): RecentListItem[] {
  if (!grouped) {
    return rows.map((row, ordinal) => ({ kind: "row", row, ordinal }));
  }
  const items: RecentListItem[] = [];
  let ordinal = 0;
  for (const group of groupByRecency(rows.map(rowRecency), now)) {
    items.push({ kind: "header", id: group.id, label: group.label, count: group.entries.length });
    for (const { row } of group.entries) items.push({ kind: "row", row, ordinal: ordinal++ });
  }
  return items;
}
