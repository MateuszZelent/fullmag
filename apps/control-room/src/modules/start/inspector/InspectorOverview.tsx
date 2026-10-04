import type { ReactNode } from "react";

import { formatBytes } from "../model/recentIndex";
import type { ModelSummary } from "../model/types";

interface Row {
  readonly label: string;
  readonly value: ReactNode;
}

function Group({ rows, title }: { readonly rows: readonly Row[]; readonly title: string }) {
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

function chips(items: readonly string[] | undefined): ReactNode {
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

const row = (label: string, value: ReactNode): Row[] =>
  value === undefined || value === null || value === "" ? [] : [{ label, value }];

/**
 * Answers "is this the project I mean, and can this machine run it?". Units
 * are part of each value, and a field the index did not record is left out
 * instead of shown as a dash.
 */
export function InspectorOverview({ summary }: { readonly summary: ModelSummary | undefined }) {
  if (!summary) {
    return (
      <p className="fm-start-inspector__note">
        No model summary was recorded for this project. Opening it reads the full model.
      </p>
    );
  }
  const model = [
    ...row("Discretisation", summary.discretisation),
    ...row("Cell size", summary.cellSize),
    ...row("Periodicity", summary.periodicity),
    ...row("Material", summary.materials?.join(", ")),
    ...row("Ms", summary.ms),
    ...row("Aex", summary.aex),
    ...row("α", summary.alpha),
    ...row("Interactions", chips(summary.interactions)),
  ];
  const execution = [
    ...row("Integrator", summary.integrator),
    ...row("Tolerance", summary.tolerance),
    ...row("Excitation", summary.excitation),
  ];
  const outputs = [
    ...row("Frames", summary.outputFrames?.toLocaleString()),
    ...row("Size", summary.outputBytes === undefined ? undefined : formatBytes(summary.outputBytes)),
    ...row("Fields", chips(summary.outputFields)),
  ];
  if (model.length + execution.length + outputs.length === 0) {
    return <p className="fm-start-inspector__note">The recorded summary is empty.</p>;
  }
  return (
    <>
      <Group rows={model} title="Model" />
      <Group rows={execution} title="Execution" />
      <Group rows={outputs} title="Outputs" />
    </>
  );
}
