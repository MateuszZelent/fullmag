import { tensorProjectionComponentLabels } from "@/kernel/api/tensorFieldProjection";
import { useQuantityCatalogResource } from "@/kernel/resources/studyRuntimeResources";
import type { VisualizationDebugPanelModel } from "./VisualizationDebugPanelModel";

const MAX_SAMPLE_ROWS = 12;
const MAX_SAMPLE_COMPONENTS = 9;

interface VisualizationDebugSampleTableProps {
  model: VisualizationDebugPanelModel;
}

export function VisualizationDebugSampleTable({
  model,
}: VisualizationDebugSampleTableProps) {
  const quantityCatalog = useQuantityCatalogResource();
  const samples = model.viewports.flatMap((viewport) =>
    viewport.carriers.flatMap((carrierGroup) =>
      carrierGroup.observations.flatMap((observation) =>
        observation.carrier.samples.map((sample) => ({
          carrierId: carrierGroup.carrierId,
          labels: tensorProjectionComponentLabels(
            quantityCatalog.data?.quantities.find((entry) => entry.id === observation.query?.quantityId)?.tensor,
            observation.query?.component, sample.componentValues.length,
          ),
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

  const firstLabels = visible[0]?.labels;
  const tensorLabels = firstLabels && visible.every((entry) => entry.labels?.join(",") === firstLabels.join(","))
    ? firstLabels : null;
  const fullTensor = tensorLabels?.length === 9;

  if (samples.length === 0) {
    return (
      <p className="fm-visualization-debug-empty">No sampled values are available.</p>
    );
  }

  if (fullTensor) {
    return (
      <div className="fm-visualization-debug-table-wrap" role="region" aria-label="Tensor field sample matrices" tabIndex={0}>
        {visible.map(({ carrierId, sample, unit }, rowIndex) => (
          <table className="fm-visualization-debug-table" aria-label={`Flow-major tensor sample ${rowIndex}`} key={`${carrierId}:${sample.pointIndex}:${rowIndex}`}>
            <caption>{carrierId} · point {formatInteger(sample.pointIndex)} · node {formatNullableInteger(sample.nodeIndex)} · {unit}</caption>
            <thead><tr><th scope="col">Flow / spin</th>{["X", "Y", "Z"].map((axis) => <th scope="col" key={axis}>Spin {axis}</th>)}</tr></thead>
            <tbody>{["X", "Y", "Z"].map((axis, flow) => (
              <tr key={axis}><th scope="row">Flow {axis}</th>{[0, 1, 2].map((spin) => {
                const component = flow * 3 + spin;
                return <td key={spin} aria-label={tensorLabels![component]}>{formatScientific(sample.componentValues[component])}</td>;
              })}</tr>
            ))}</tbody>
            <tfoot><tr><th scope="row">Frobenius</th><td colSpan={3}>{formatScientific(sample.magnitude)} {unit}</td></tr></tfoot>
          </table>
        ))}
        <p className="fm-visualization-debug-caption">Showing {visible.length} of {samples.length} samples. Rows are flow directions; columns are spin polarizations.</p>
      </div>
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
              <th scope="col" key={index}>{tensorLabels?.[index] ?? `c${index}`}</th>
            ))}
            <th scope="col">{fullTensor ? "Frobenius" : "Magnitude"}</th>
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
        Showing {visible.length} of {samples.length} samples; at most 9 components
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
