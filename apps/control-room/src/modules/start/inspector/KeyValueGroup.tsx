import type { ReactNode } from "react";

export interface KvRow {
  readonly label: string;
  readonly value: ReactNode;
}

/** A titled definition list; a group with no rows renders nothing. */
export function KvGroup({ rows, title }: { readonly rows: readonly KvRow[]; readonly title: string }) {
  if (rows.length === 0) return null;
  return (
    <section className="fm-start-kv">
      <h3 className="fm-start-kv__title">{title}</h3>
      <dl className="fm-start-kv__grid">
        {rows.map((row) => (
          <div className="fm-start-kv__row" key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Chips for a short list of names; `undefined` when there is nothing to show. */
export function chipList(items: readonly string[] | undefined): ReactNode {
  if (!items || items.length === 0) return undefined;
  return (
    <span className="fm-start-chips">
      {items.map((item) => (
        <span className="fm-start-chip" key={item}>
          {item}
        </span>
      ))}
    </span>
  );
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
