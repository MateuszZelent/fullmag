"use client";

import { useMemo, useState } from "react";

import type { DynamicStructureFactorResource } from "@/kernel/api/apiTypes";

import { EChartsSurface } from "./components/EChartsSurface";
import { dynamicStructureFactorCells, dynamicStructureFactorFrequencyCut, dynamicStructureFactorWavevectorCut } from "./dynamicStructureFactorModel";

export function DynamicStructureFactorView({
  resource,
}: {
  resource: DynamicStructureFactorResource | null;
}) {
  const [scale, setScale] = useState<"linear" | "log">("log");
  const [spectrum, setSpectrum] = useState<"response" | "source">("response");
  const cells = dynamicStructureFactorCells(resource, spectrum);
  const [wavevectorIndex, setWavevectorIndex] = useState(0);
  const [frequencyIndex, setFrequencyIndex] = useState(1);
  const heatmapColumns = useMemo(() => new Set(cells.map((cell) => cell.wavevectorIndex)).size, [cells]);
  const boundedWavevectorIndex = Math.min(wavevectorIndex, Math.max(0, (resource?.wavevector_count ?? 1) - 1));
  const boundedFrequencyIndex = Math.min(frequencyIndex, Math.max(0, (resource?.frequency_count ?? 1) - 1));
  return (
    <section className="fm-analysis-plots__panel" aria-label="Dynamic structure factor">
      <header className="fm-analysis-plots__header">
        <h3>Dynamic structure factor S(k,f)</h3>
        <span>k [rad/m] · f [Hz] · bounded heatmap</span>
      </header>
      <div className="fm-analysis-plots__status" aria-label="Dynamic structure factor controls">
        <label>Scale <select className="fm-analysis-plots__select" value={scale} onChange={(event) => setScale(event.target.value as "linear" | "log")}><option value="log">log</option><option value="linear">linear</option></select></label>
        <label>Spectrum <select className="fm-analysis-plots__select" value={spectrum} onChange={(event) => setSpectrum(event.target.value as "response" | "source")}><option value="response">S(k,f)</option><option value="source">H(k,f)</option></select></label>
        <label>k cut <select className="fm-analysis-plots__select" value={boundedWavevectorIndex} onChange={(event) => setWavevectorIndex(Number(event.target.value))}>{resource?.k_rad_per_m.map((value, index) => <option key={index} value={index}>{value.toExponential(3)} rad/m</option>)}</select></label>
        <label>f cut <select className="fm-analysis-plots__select" value={boundedFrequencyIndex} onChange={(event) => setFrequencyIndex(Number(event.target.value))}>{resource?.frequency_hz.map((value, index) => <option key={index} value={index}>{value.toExponential(3)} Hz</option>)}</select></label>
      </div>
      <div
        className="fm-analysis-plots__heatmap"
        role="img"
        aria-label={`${cells.length} sampled S(k,f) cells`}
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, heatmapColumns)}, minmax(2px, 1fr))`,
        }}
      >
        {cells.map((cell, index) => (
          <span
            className="fm-analysis-plots__heatmap-cell"
            key={index}
            style={{ opacity: Math.max(0.04, scale === "log" ? cell.logNormalizedPower : cell.normalizedPower) }}
            title={`k=${cell.kRadPerM.toExponential(4)} rad/m, f=${cell.frequencyHz.toExponential(4)} Hz, ${spectrum === "source" ? "|H|²" : "S"}=${cell.power.toExponential(4)}`}
          />
        ))}
      </div>
      <div className="fm-analysis-plots__subchart">
        <header className="fm-analysis-plots__subchart-header"><h4>Frequency line cut</h4><span>k={resource?.k_rad_per_m[boundedWavevectorIndex]?.toExponential(4) ?? "-"} rad/m</span></header>
        <EChartsSurface dataStatus={resource ? "ready" : "idle"} series={dynamicStructureFactorFrequencyCut(resource, boundedWavevectorIndex, spectrum)} xAxisLabel={`frequency [${resource?.frequency_unit ?? "Hz"}]`} />
      </div>
      <div className="fm-analysis-plots__subchart">
        <header className="fm-analysis-plots__subchart-header"><h4>Wavevector line cut</h4><span>f={resource?.frequency_hz[boundedFrequencyIndex]?.toExponential(4) ?? "-"} Hz</span></header>
        <EChartsSurface dataStatus={resource ? "ready" : "idle"} series={dynamicStructureFactorWavevectorCut(resource, boundedFrequencyIndex, spectrum)} xAxisLabel={`wavevector [${resource?.wavevector_unit ?? "rad/m"}]`} />
      </div>
    </section>
  );
}
