
import { type KvRow } from "./KeyValueGroup.model";

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
