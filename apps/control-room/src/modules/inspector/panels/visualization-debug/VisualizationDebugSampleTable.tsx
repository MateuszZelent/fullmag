import type { VisualizationDebugPanelModel } from "./VisualizationDebugPanelModel";

const MAX_SAMPLE_ROWS = 12;
const MAX_SAMPLE_COMPONENTS = 8;

interface VisualizationDebugSampleTableProps {
  model: VisualizationDebugPanelModel;
}

export function VisualizationDebugSampleTable({
  model,
}: VisualizationDebugSampleTableProps) {
  const samples = model.viewports.flatMap((viewport) =>
    viewport.carriers.flatMap((carrierGroup) =>
      carrierGroup.observations.flatMap((observation) =>
        observation.carrier.samples.map((sample) => ({
          carrierId: carrierGroup.carrierId,
          sample,
          unit: observation.backendMeta?.unit ?? "unknown",
        })),
      ),
    ),
  );
  const visible = samples.slice(0, MAX_SAMPLE_ROWS);
  const componentCount = Math.min(
    MAX_SAMPLE_COMPONENTS,
    visible.reduce(
      (maximum, entry) =>
        Math.max(maximum, entry.sample.componentValues.length),
      0,
    ),
  );

  if (samples.length === 0) {
    return (
      <p className="fm-visualization-debug-empty">No sampled values are available.</p>
    );
  }

  return (
    <div className="fm-visualization-debug-table-wrap">
      <table
        className="fm-visualization-debug-table"
        aria-label="Bounded visualization field samples"
      >
        <thead>
          <tr>
            <th scope="col">Carrier</th>
            <th scope="col">Point index</th>
            <th scope="col">Node index</th>
            {Array.from({ length: componentCount }, (_, index) => (
              <th scope="col" key={index}>{`c${index}`}</th>
            ))}
            <th scope="col">Magnitude</th>
            <th scope="col">Unit</th>
          </tr>
        </thead>
        <tbody>
          {visible.map(({ carrierId, sample, unit }, rowIndex) => (
            <tr
              data-sample-row={`${carrierId}:${sample.pointIndex}:${rowIndex}`}
              key={`${carrierId}:${sample.pointIndex}:${rowIndex}`}
            >
              <th scope="row">{carrierId}</th>
              <td>{formatInteger(sample.pointIndex)}</td>
              <td>{formatNullableInteger(sample.nodeIndex)}</td>
              {Array.from({ length: componentCount }, (_, componentIndex) => (
                <td key={componentIndex}>
                  {formatScientific(sample.componentValues[componentIndex] ?? null)}
                </td>
              ))}
              <td>{formatScientific(sample.magnitude)}</td>
              <td>{unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fm-visualization-debug-caption">
        Showing {visible.length} of {samples.length} samples; at most 8 components
        per row.
      </p>
    </div>
  );
}

export function formatScientific(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e4 || magnitude < 1e-3) return value.toExponential(4);
  return value.toLocaleString("en-US", { maximumSignificantDigits: 6 });
}

function formatInteger(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatNullableInteger(value: number | null): string {
  return value == null ? "—" : formatInteger(value);
}
