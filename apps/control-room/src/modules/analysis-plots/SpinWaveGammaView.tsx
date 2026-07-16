"use client";

import type { SpinWaveGammaResource } from "@/kernel/api/apiTypes";

import { EChartsSurface } from "./components/EChartsSurface";
import {
  spinWaveGammaResponseTraceSeries,
  spinWaveGammaSeries,
  spinWaveGammaSourceTraceSeries,
  spinWaveGammaSamplingSummary,
} from "./spinWaveGammaModel";

export function SpinWaveGammaView({
  resource,
  status,
}: {
  resource: SpinWaveGammaResource | null;
  status: string;
}) {
  const sampling = spinWaveGammaSamplingSummary(resource);
  return (
    <section className="fm-analysis-plots__panel" aria-label="Gamma spin-wave response">
      <header className="fm-analysis-plots__header">
        <h3>Γ spin-wave response</h3>
        <span>{resource?.weighting ?? "moment weighted"} · {resource?.detrend ?? "detrend"} · {resource?.window ?? "window"}</span>
      </header>
      <div className="fm-analysis-plots__status" role="list" aria-label="Response FFT sampling parameters">
        <span role="listitem">N {sampling.sampleCount}</span>
        <span role="listitem">t_sampling {formatScientific(sampling.samplePeriodS, "s")}</span>
        <span role="listitem">duration {formatScientific(sampling.durationS, "s")}</span>
        <span role="listitem">df {formatScientific(sampling.frequencyResolutionHz, "Hz")}</span>
        <span role="listitem">Nyquist {formatScientific(sampling.nyquistHz, "Hz")}</span>
      </div>
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
        <div className="fm-analysis-plots__columns" role="table" aria-label="Gamma spectrum peaks">
          <div className="fm-analysis-plots__column-header" role="row"><span>#</span><span>bin</span><span>frequency [Hz]</span><span>power</span></div>
          {resource.peaks.map((peak, rank) => (
            <div className="fm-analysis-plots__column-row" role="row" key={peak.index}>
              <span>{rank + 1}</span><span>{peak.index}</span><span>{peak.frequency_hz.toExponential(5)}</span><span>{peak.power.toExponential(3)}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="fm-analysis-plots__status">
        <span>Peaks {resource?.peaks.length ?? 0}</span>
        <span>Samples {resource?.time_s.length ?? 0}</span>
      </div>
    </section>
  );
}

function formatScientific(value: number | null, unit: string): string {
  return value === null ? "unavailable" : `${value.toExponential(3)} ${unit}`;
}
