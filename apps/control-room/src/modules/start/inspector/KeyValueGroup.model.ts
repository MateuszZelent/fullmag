import type { ReactNode } from "react";

export interface KvRow {
  readonly label: string;
  readonly value: ReactNode;
}

/** A row for a value that may be absent: nothing is listed for it. */
export const kvRow = (label: string, value: ReactNode): KvRow[] =>
  value === undefined || value === null || value === "" ? [] : [{ label, value }];

/** A row that is always listed; an absent value reads "unavailable". */
export const kvRowOrUnavailable = (label: string, value: ReactNode): KvRow[] => [
  {
    label,
    value: value === undefined || value === null || value === "" ? "unavailable" : value,
  },
];
