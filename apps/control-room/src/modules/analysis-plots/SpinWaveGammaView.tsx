"use client";

import type { SpinWaveGammaResource } from "@/kernel/api/apiTypes";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import { EChartsSurface } from "./components/EChartsSurface";
import {
  spinWaveGammaFeatureSelection,
  spinWaveGammaResponseTraceSeries,
  spinWaveGammaSeries,
  spinWaveGammaSourceTraceSeries,
  spinWaveGammaSamplingSummary,
} from "./spinWaveGammaModel";

export function SpinWaveGammaView({
  resource,
  status,
  onFeatureSelect,
}: {
  resource: SpinWaveGammaResource | null;
  status: string;
  onFeatureSelect?: (selection: import("./spinWaveGammaModel").SpinWaveGammaFeatureSelection) => void;
}) {
  const sampling = spinWaveGammaSamplingSummary(resource);
  const subtitle = resource
    ? `${resource.weighting ?? "moment weighted"} · ${resource.detrend ?? "detrend"} · ${resource.window ?? "window"}`
    : undefined;

  return (
    <ChartSection
      className="fm-analysis-plots__panel--gamma"
      status={{
        primary: status === "ready" ? "Ready" : status,
        revision: resource?.schema_version ?? null,
        trust: "unknown",
        pointSummary: sampling.sampleCount ? `${sampling.sampleCount} samples` : undefined,
      }}
      title="Γ spin-wave response"
      subtitle={subtitle}
    >
      <ul className="fm-analysis-plots__status fm-analysis-plots__status-list" aria-label="Response FFT sampling parameters">
        <li>N {sampling.sampleCount}</li>
        <li>t_sampling {formatScientific(sampling.samplePeriodS, "s")}</li>
        <li>duration {formatScientific(sampling.durationS, "s")}</li>
        <li>df {formatScientific(sampling.frequencyResolutionHz, "Hz")}</li>
        <li>Nyquist {formatScientific(sampling.nyquistHz, "Hz")}</li>
      </ul>
      {sampling.message ? <p className="fm-analysis-plots__sampling-warning" role="status">{sampling.message}</p> : null}
      <div className="fm-analysis-plots__subchart">
        <header className="fm-analysis-plots__subchart-header"><h4>Response trace Δm(t)</h4><span>time [{resource?.time_unit ?? "s"}]</span></header>
        <EChartsSurface dataStatus={status} series={spinWaveGammaResponseTraceSeries(resource)} xAxisLabel={`time [${resource?.time_unit ?? "s"}]`} />
      </div>
      <div className="fm-analysis-plots__subchart">
        <header className="fm-analysis-plots__subchart-header"><h4>Drive / antenna trace H(t)</h4><span>{resource?.source_unit ?? "A/m"}</span></header>
        <EChartsSurface dataStatus={status} series={spinWaveGammaSourceTraceSeries(resource)} xAxisLabel={`time [${resource?.time_unit ?? "s"}]`} />
      </div>
      <div className="fm-analysis-plots__subchart">
        <header className="fm-analysis-plots__subchart-header"><h4>Response and antenna FFT spectra</h4><span>frequency [{resource?.frequency_unit ?? "Hz"}]</span></header>
        <EChartsSurface dataStatus={status} series={spinWaveGammaSeries(resource)} xAxisLabel={`frequency [${resource?.frequency_unit ?? "Hz"}]`} />
      </div>
      {resource && resource.peaks.length > 0 ? (
        <div className="fm-analysis-plots__columns">
          <table className="fm-analysis-plots__native-table" aria-label="Gamma spectrum peaks">
          <thead>
            <tr className="fm-analysis-plots__column-header"><th scope="col">#</th><th scope="col">bin</th><th scope="col">frequency [Hz]</th><th scope="col">power</th></tr>
          </thead>
          <tbody>
          {resource.peaks.map((peak, rank) => {
            const selection = spinWaveGammaFeatureSelection(peak);
            const selectable = Boolean(selection && onFeatureSelect);
            const activate = () => {
              if (!selection || !onFeatureSelect) return;
              onFeatureSelect(selection);
            };
            return <tr
              aria-disabled={!selectable || undefined}
              aria-label={selectable ? `Select spectral feature ${peak.index}` : `Unavailable spectral feature ${peak.index}`}
              className="fm-analysis-plots__column-row"
              {...(selection ? { "data-result-item-id": selection.itemId } : {})}
              key={peak.index}
              onClick={selectable ? activate : undefined}
              onKeyDown={selectable ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  activate();
                }
              } : undefined}
              tabIndex={selectable ? 0 : -1}
            >
              <td>{rank + 1}</td><td>{peak.index}</td><td>{peak.frequency_hz.toExponential(5)}</td><td>{peak.power.toExponential(3)}</td>
            </tr>;
          })}
          </tbody>
          </table>
        </div>
      ) : null}
      <div className="fm-analysis-plots__status">
        <span>Peaks {resource?.peaks.length ?? 0}</span>
        <span>Samples {resource?.time_s.length ?? 0}</span>
      </div>
    </ChartSection>
  );
}

function formatScientific(value: number | null, unit: string): string {
  return value === null ? "unavailable" : `${value.toExponential(3)} ${unit}`;
}
