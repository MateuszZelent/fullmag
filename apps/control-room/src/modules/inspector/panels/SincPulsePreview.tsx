import type { SincPulsePreviewModel } from "@/shared/domain/physics/sincPulsePreview";

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
        xLabel="time [s]"
        markerLabel="t0"
      />
      <PreviewPlot
        points={model.spectrum.map((point) => [point.frequencyHz, point.magnitude])}
        marker={model.cutoffHz}
        title="Sampled source spectrum |FFT(B)|"
        xLabel="frequency [Hz]"
        markerLabel="fc"
      />
      <div className="fm-sinc-preview__metrics" role="list" aria-label="FFT sampling parameters">
        <Metric label="t0" value={engineering(model.t0S, "s")} />
        <Metric label="window before t0" value={engineering(model.leftOfCenterS, "s")} />
        <Metric label="window after t0" value={engineering(model.rightOfCenterS, "s")} />
        <Metric label="solver dt" value={solverDtS ? engineering(solverDtS, "s") : "not declared"} />
        <Metric label="t_sampling" value={engineering(model.samplePeriodS, "s")} />
        <Metric label="samples N" value={String(model.sampleCount)} />
        <Metric label="duration" value={engineering(model.durationS, "s")} />
        <Metric label="df" value={engineering(model.frequencyResolutionHz, "Hz")} />
        <Metric label="Nyquist" value={engineering(model.nyquistHz, "Hz")} />
        <Metric label="sinc cutoff" value={engineering(model.cutoffHz, "Hz")} />
      </div>
      <p
        className={`fm-sinc-preview__message fm-sinc-preview__message--${model.isSymmetricWindow ? "ready" : "preview_only"}`}
        role="status"
      >
        {model.symmetryMessage} Symmetry is assessed with τ = t - t0; the horizontal axis remains the authored time t and t0 is never recentered silently.
      </p>
      {model.message ? <p className={`fm-sinc-preview__message fm-sinc-preview__message--${model.status}`}>{model.message}</p> : null}
    </div>
  );
}

function PreviewPlot({
  points,
  marker,
  title,
  xLabel,
  markerLabel,
}: {
  points: Array<[number, number]>;
  marker: number;
  title: string;
  xLabel: string;
  markerLabel: string;
}) {
  const width = 320;
  const height = 112;
  const inset = { left: 34, right: 10, top: 18, bottom: 24 };
  const xMin = points[0]?.[0] ?? 0;
  const xMax = points.at(-1)?.[0] ?? 1;
  const yExtent = Math.max(...points.map((point) => Math.abs(point[1])), 1e-30);
  const plotWidth = width - inset.left - inset.right;
  const plotHeight = height - inset.top - inset.bottom;
  const x = (value: number) => inset.left + ((value - xMin) / Math.max(xMax - xMin, 1e-30)) * plotWidth;
  const y = (value: number) => inset.top + 0.5 * plotHeight - (value / yExtent) * 0.45 * plotHeight;
  const polyline = points.map((point) => `${x(point[0]).toFixed(2)},${y(point[1]).toFixed(2)}`).join(" ");
  const markerX = x(Math.min(Math.max(marker, xMin), xMax));
  return (
    <figure className="fm-sinc-preview__plot">
      <figcaption><strong>{title}</strong><span>{xLabel}</span></figcaption>
      <svg role="img" aria-label={`${title}; ${markerLabel}=${marker.toExponential(4)}`} viewBox={`0 0 ${width} ${height}`}>
        <line className="fm-sinc-preview__axis" x1={inset.left} x2={width - inset.right} y1={y(0)} y2={y(0)} />
        <line className="fm-sinc-preview__marker" x1={markerX} x2={markerX} y1={inset.top} y2={height - inset.bottom} />
        <polyline className="fm-sinc-preview__line" fill="none" points={polyline} />
        <text className="fm-sinc-preview__marker-label" x={Math.min(markerX + 4, width - 26)} y={inset.top + 9}>{markerLabel}</text>
        <text className="fm-sinc-preview__tick" x={inset.left} y={height - 6}>{engineering(xMin, "")}</text>
        <text className="fm-sinc-preview__tick" textAnchor="end" x={width - inset.right} y={height - 6}>{engineering(xMax, "")}</text>
      </svg>
    </figure>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <span role="listitem"><small>{label}</small><strong>{value}</strong></span>;
}

function engineering(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "invalid";
  if (value === 0) return `0${unit ? ` ${unit}` : ""}`;
  const exponent = Math.floor(Math.log10(Math.abs(value)) / 3) * 3;
  const prefixes: Record<number, string> = { [-15]: "f", [-12]: "p", [-9]: "n", [-6]: "µ", [-3]: "m", 0: "", 3: "k", 6: "M", 9: "G", 12: "T" };
  const prefix = prefixes[exponent];
  if (prefix !== undefined) return `${(value / 10 ** exponent).toPrecision(4)} ${prefix}${unit}`.trim();
  return `${value.toExponential(3)}${unit ? ` ${unit}` : ""}`;
}
