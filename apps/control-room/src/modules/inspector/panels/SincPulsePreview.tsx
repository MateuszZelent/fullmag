import type { SincPulsePreviewModel } from "@/shared/domain/physics/sincPulsePreview";
import { formatEngineering } from "./stages/samplingPresentation";

export function SincPulsePreview({
  model,
  solverDtS,
}: {
  model: SincPulsePreviewModel;
  solverDtS: number | null;
}) {
  return (
    <div className="fm-sinc-preview" aria-label="Sinc pulse and source FFT preview">
      <PreviewPlot
        points={model.waveform.map((point) => [point.timeS, point.value])}
        marker={model.t0S}
        title="Sinc waveform B(t)"
        xLabel="time"
        xUnit="s"
        markerLabel="t0"
      />
      <PreviewPlot
        points={model.spectrum.map((point) => [point.frequencyHz, point.magnitude])}
        marker={model.cutoffHz}
        title="Sampled source spectrum |FFT(B)|"
        xLabel="frequency"
        xUnit="Hz"
        markerLabel="fc"
      />
      <div className="fm-sinc-preview__metrics" role="list" aria-label="FFT sampling parameters">
        <Metric label="t0" value={formatEngineering(model.t0S, "s")} />
        <Metric label="window before t0" value={formatEngineering(model.leftOfCenterS, "s")} />
        <Metric label="window after t0" value={formatEngineering(model.rightOfCenterS, "s")} />
        <Metric label="solver dt" value={solverDtS ? formatEngineering(solverDtS, "s") : "not declared"} />
        <Metric label="t_sampling" value={formatEngineering(model.samplePeriodS, "s")} />
        <Metric label="samples N" value={String(model.sampleCount)} />
        <Metric label="duration" value={formatEngineering(model.durationS, "s")} />
        <Metric label="df" value={formatEngineering(model.frequencyResolutionHz, "Hz")} />
        <Metric label="Nyquist" value={formatEngineering(model.nyquistHz, "Hz")} />
        <Metric label="sinc cutoff" value={formatEngineering(model.cutoffHz, "Hz")} />
        <Metric
          label="maximum t_sampling for fc"
          value={formatEngineering(model.maximumSamplePeriodForCutoffS, "s")}
        />
      </div>
      <p
        className={`fm-sinc-preview__message fm-sinc-preview__message--${model.isSymmetricWindow ? "ready" : "preview_only"}`}
        role="status"
      >
        {model.symmetryMessage} Symmetry is assessed with τ = t - t0; the horizontal axis remains the authored time t and t0 is never recentered silently.
      </p>
      {model.message ? <p className={`fm-sinc-preview__message fm-sinc-preview__message--${model.status}`}>{model.message}</p> : null}
      <p
        className={`fm-sinc-preview__message fm-sinc-preview__message--${model.nyquistStatus === "pass" ? "ready" : model.nyquistStatus === "fail" ? "unavailable" : "preview_only"}`}
        role="status"
      >
        {model.nyquistMessage}
      </p>
    </div>
  );
}

function PreviewPlot({
  points,
  marker,
  title,
  xLabel,
  xUnit,
  markerLabel,
}: {
  points: Array<[number, number]>;
  marker: number;
  title: string;
  xLabel: string;
  xUnit: string;
  markerLabel: string;
}) {
  const width = 320;
  const height = 112;
  const inset = { left: 34, right: 10, top: 18, bottom: 24 };
  const xMin = points[0]?.[0] ?? 0;
  const xMax = points.at(-1)?.[0] ?? 1;
  const yExtent = points.reduce(
    (maximum, point) => Math.max(maximum, Math.abs(point[1])),
    1e-30,
  );
  const plotWidth = width - inset.left - inset.right;
  const plotHeight = height - inset.top - inset.bottom;
  const x = (value: number) => inset.left + ((value - xMin) / Math.max(xMax - xMin, 1e-30)) * plotWidth;
  const y = (value: number) => inset.top + 0.5 * plotHeight - (value / yExtent) * 0.45 * plotHeight;
  const polyline = points.map((point) => `${x(point[0]).toFixed(2)},${y(point[1]).toFixed(2)}`).join(" ");
  const markerX = x(Math.min(Math.max(marker, xMin), xMax));
  return (
    <figure className="fm-sinc-preview__plot">
      <figcaption><strong>{title}</strong><span>{xLabel}</span></figcaption>
      <svg role="img" aria-label={`${title}; ${markerLabel}=${formatEngineering(marker, xUnit)}`} viewBox={`0 0 ${width} ${height}`}>
        <line className="fm-sinc-preview__axis" x1={inset.left} x2={width - inset.right} y1={y(0)} y2={y(0)} />
        <line className="fm-sinc-preview__marker" x1={markerX} x2={markerX} y1={inset.top} y2={height - inset.bottom} />
        <polyline className="fm-sinc-preview__line" fill="none" points={polyline} />
        <text className="fm-sinc-preview__marker-label" x={Math.min(markerX + 4, width - 26)} y={inset.top + 9}>{markerLabel}</text>
        <text className="fm-sinc-preview__tick" x={inset.left} y={height - 6}>{formatEngineering(xMin, xUnit)}</text>
        <text className="fm-sinc-preview__tick" textAnchor="end" x={width - inset.right} y={height - 6}>{formatEngineering(xMax, xUnit)}</text>
      </svg>
    </figure>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <span role="listitem"><small>{label}</small><strong>{value}</strong></span>;
}
