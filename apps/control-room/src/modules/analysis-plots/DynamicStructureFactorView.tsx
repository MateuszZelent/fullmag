"use client";

import { useMemo, useState } from "react";

import type { DynamicStructureFactorResource } from "@/kernel/api/apiTypes";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import { EChartsSurface } from "./components/EChartsSurface";
import {
  dynamicStructureFactorCells,
  dynamicStructureFactorFrequencyCut,
  dynamicStructureFactorPointSelection,
  dynamicStructureFactorWavevectorCut,
  type DynamicStructureFactorPointSelection,
} from "./dynamicStructureFactorModel";

export function DynamicStructureFactorView({
  resource,
  status,
  onPointSelect,
}: {
  resource: DynamicStructureFactorResource | null;
  status: string;
  onPointSelect?: (selection: DynamicStructureFactorPointSelection) => void;
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
    <ChartSection
      className="fm-analysis-plots__panel--dsf"
      status={{
        primary: status === "ready" ? "Ready" : status,
        revision: resource?.schema_version ?? null,
        trust: "unknown",
        pointSummary: cells.length > 0 ? `${cells.length} cells` : undefined,
      }}
      title="Dynamic structure factor S(k,f)"
      subtitle="k [rad/m] · f [Hz] · bounded heatmap"
    >
      <div className="fm-analysis-plots__status" aria-label="Dynamic structure factor controls">
        <label>Scale <Select value={scale} onValueChange={(value) => setScale(value as "linear" | "log")}><SelectTrigger aria-label="Scale"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="log">Log</SelectItem><SelectItem value="linear">Linear</SelectItem></SelectContent></Select></label>
        <label>Spectrum <Select value={spectrum} onValueChange={(value) => setSpectrum(value as "response" | "source")}><SelectTrigger aria-label="Spectrum"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="response">S(k,f)</SelectItem><SelectItem value="source">H(k,f)</SelectItem></SelectContent></Select></label>
        <label>k cut <Select value={String(boundedWavevectorIndex)} onValueChange={(value) => setWavevectorIndex(Number(value))}><SelectTrigger aria-label="Wavevector cut"><SelectValue /></SelectTrigger><SelectContent>{resource?.k_rad_per_m.map((value, index) => <SelectItem key={index} value={String(index)}>{value.toExponential(3)} rad/m</SelectItem>)}</SelectContent></Select></label>
        <label>f cut <Select value={String(boundedFrequencyIndex)} onValueChange={(value) => setFrequencyIndex(Number(value))}><SelectTrigger aria-label="Frequency cut"><SelectValue /></SelectTrigger><SelectContent>{resource?.frequency_hz.map((value, index) => <SelectItem key={index} value={String(index)}>{value.toExponential(3)} Hz</SelectItem>)}</SelectContent></Select></label>
      </div>
      <div
        className="fm-analysis-plots__heatmap"
        role="grid"
        aria-label={`${cells.length} sampled S(k,f) cells`}
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, heatmapColumns)}, minmax(2px, 1fr))`,
        }}
      >
        {cells.map((cell) => {
          const selection = dynamicStructureFactorPointSelection(resource, cell.frequencyIndex, cell.wavevectorIndex);
          const itemId = `legacy:dsf:${cell.frequencyIndex}:${cell.wavevectorIndex}`;
          const resultItemId = selection?.itemId ?? itemId;
          const selectable = Boolean(selection && onPointSelect);
          const activate = () => {
            if (selection && onPointSelect) onPointSelect(selection);
          };
          return <span
            aria-disabled={!selectable || undefined}
            aria-label={selectable ? `Select DSF point ${cell.frequencyIndex}:${cell.wavevectorIndex}` : `Unavailable DSF point ${cell.frequencyIndex}:${cell.wavevectorIndex}`}
            className="fm-analysis-plots__heatmap-cell"
            data-result-item-id={resultItemId}
            key={itemId}
            onClick={selectable ? activate : undefined}
            onKeyDown={selectable ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activate();
              }
            } : undefined}
            role="gridcell"
            style={{ opacity: Math.max(0.04, scale === "log" ? cell.logNormalizedPower : cell.normalizedPower) }}
            tabIndex={selectable ? 0 : -1}
            title={`k=${cell.kRadPerM.toExponential(4)} rad/m, f=${cell.frequencyHz.toExponential(4)} Hz, ${spectrum === "source" ? "|H|²" : "S"}=${cell.power.toExponential(4)}`}
          />;
        })}
      </div>
      <div className="fm-analysis-plots__subchart">
        <header className="fm-analysis-plots__subchart-header"><h4>Frequency line cut</h4><span>k={resource?.k_rad_per_m[boundedWavevectorIndex]?.toExponential(4) ?? "-"} rad/m</span></header>
        <EChartsSurface dataStatus={status} onPointSelect={(point) => {
          const selection = dynamicStructureFactorPointSelection(resource, point.point.rowIndex, boundedWavevectorIndex);
          if (selection) onPointSelect?.(selection);
        }} series={dynamicStructureFactorFrequencyCut(resource, boundedWavevectorIndex, spectrum)} xAxisLabel={`frequency [${resource?.frequency_unit ?? "Hz"}]`} />
      </div>
      <div className="fm-analysis-plots__subchart">
        <header className="fm-analysis-plots__subchart-header"><h4>Wavevector line cut</h4><span>f={resource?.frequency_hz[boundedFrequencyIndex]?.toExponential(4) ?? "-"} Hz</span></header>
        <EChartsSurface dataStatus={status} onPointSelect={(point) => {
          const selection = dynamicStructureFactorPointSelection(resource, boundedFrequencyIndex, point.point.rowIndex);
          if (selection) onPointSelect?.(selection);
        }} series={dynamicStructureFactorWavevectorCut(resource, boundedFrequencyIndex, spectrum)} xAxisLabel={`wavevector [${resource?.wavevector_unit ?? "rad/m"}]`} />
      </div>
    </ChartSection>
  );
}
