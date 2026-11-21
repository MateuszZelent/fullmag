import type { ReactNode } from "react";

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
