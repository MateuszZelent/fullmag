import { formatBytes } from "../model/recentIndex";
import type { ModelSummary } from "../model/types";

import { KvGroup, chipList, kvRow as kvRowIfPresent, kvRowOrUnavailable } from "./KeyValueGroup";

/**
 * Answers "is this the project I mean, and can this machine run it?". Units
 * are part of each value, and a field the index did not record is left out
 * instead of shown as a dash, unless `listEveryField` asks for the sketch's
 * full list, where a field the backend did not send reads "unavailable".
 */
export function InspectorOverview({
  summary,
  listEveryField = false,
}: {
  readonly summary: ModelSummary | undefined;
  readonly listEveryField?: boolean;
}) {
  const kvRow = listEveryField ? kvRowOrUnavailable : kvRowIfPresent;
  if (!summary) {
    return (
      <p className="fm-start-inspector__note">
        No model summary was recorded for this project. Opening it reads the full model.
      </p>
    );
  }
  const model = [
    ...kvRow("Discretisation", summary.discretisation),
    ...kvRow("Cell size", summary.cellSize),
    ...kvRow("Periodicity", summary.periodicity),
    ...kvRow("Material", summary.materials?.join(", ")),
    ...kvRow("Ms", summary.ms),
    ...kvRow("Aex", summary.aex),
    ...kvRow("α", summary.alpha),
    ...kvRow("Interactions", chipList(summary.interactions)),
  ];
  const execution = [
    ...kvRow("Integrator", summary.integrator),
    ...kvRow("Tolerance", summary.tolerance),
    ...kvRow("Excitation", summary.excitation),
  ];
  const outputs = [
    ...kvRow("Frames", summary.outputFrames?.toLocaleString()),
    ...kvRow("Size", summary.outputBytes === undefined ? undefined : formatBytes(summary.outputBytes)),
    ...kvRow("Fields", chipList(summary.outputFields)),
  ];
  if (model.length + execution.length + outputs.length === 0) {
    return <p className="fm-start-inspector__note">The recorded summary is empty.</p>;
  }
  return (
    <>
      <KvGroup rows={model} title="Model" />
      <KvGroup rows={execution} title="Execution" />
      <KvGroup rows={outputs} title="Outputs" />
    </>
  );
}
