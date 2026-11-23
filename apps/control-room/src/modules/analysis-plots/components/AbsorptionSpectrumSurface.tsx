"use client";

import { useId, useMemo, useState } from "react";

import { ChartLegend } from "@/shared/analysis-charts/ChartLegend";
import { chartColorNameForIndex } from "@/shared/analysis-charts/ChartLegend.model";
import { ChartSection } from "@/shared/analysis-charts/ChartSection";
import { createChartDisplayTransform, formatChartDisplayValue } from "@/shared/analysis-charts/chartScalePolicy";
import { formatTooltipValue } from "@/shared/analysis-charts/scientificChartFormatting";
import { MAX_REFERENCE_FILE_BYTES } from "@/shared/domain/analysis/referenceImport";

import {
  ABSORBED_POWER_QUANTITY,
  parseAbsorptionSpectrum,
  type AbsorptionSpectrum,
} from "../absorptionSpectrumModel";
import { EChartsSurface } from "./EChartsSurface";

const IMPORTED_SPECTRUM_PROVENANCE = { decimation: "none", provenance: "Imported CSV" };

interface AbsorptionSpectrumSurfaceProps {
  onImport: (spectrum: AbsorptionSpectrum) => void;
  spectrum: AbsorptionSpectrum | null;
}

export function AbsorptionSpectrumSurface({ onImport, spectrum }: AbsorptionSpectrumSurfaceProps) {
  const inputId = useId();
  const helpId = useId();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function importFile(file: File) {
    setError(null);
    setLoading(true);
    try {
      if (file.size > MAX_REFERENCE_FILE_BYTES) {
        throw new Error("Choose a CSV file no larger than 4 MiB.");
      }
      onImport(parseAbsorptionSpectrum(await file.text(), file.name));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read the absorption spectrum.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="fm-absorption-spectrum" aria-label="RF absorption">
      <div className="fm-absorption-spectrum__import">
        <label htmlFor={inputId}>Import absorption CSV</label>
        <input
          accept=".csv,text/csv"
          aria-describedby={helpId}
          aria-invalid={error !== null}
          disabled={loading}
          id={inputId}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void importFile(file);
          }}
          type="file"
        />
        <p id={helpId}>
          Use frequency_Hz and one absorbed power column ending in _W per RF drive profile.
          Units come from the CSV headers. Fullmag keeps the file in this tab and cannot verify its calculation.
        </p>
        {loading ? <p role="status">Reading spectrum…</p> : null}
        {error ? <p role="alert">{error}</p> : null}
      </div>
      {spectrum ? <AbsorptionChart spectrum={spectrum} /> : null}
    </section>
  );
}

function AbsorptionChart({ spectrum }: { spectrum: AbsorptionSpectrum }) {
  const [selection, setSelection] = useState<{
    spectrum: AbsorptionSpectrum;
    seriesIds: string[];
  } | null>(null);
  const allSeries = useMemo(() => spectrum.profiles.map(({ series }) => series), [spectrum]);
  const allSeriesIds = useMemo(() => allSeries.map(({ id }) => id), [allSeries]);
  const visibleIds = selection?.spectrum === spectrum ? selection.seriesIds : allSeriesIds;
  const visibleSeries = useMemo(() => {
    const visible = new Set(visibleIds);
    return allSeries.filter(({ id }) => visible.has(id));
  }, [allSeries, visibleIds]);
  const displayUnits = useMemo(() => ({
    x: "GHz",
    [ABSORBED_POWER_QUANTITY]: spectrum.powerDisplayUnit,
  }), [spectrum.powerDisplayUnit]);
  const powerTransform = createChartDisplayTransform("W", null, spectrum.powerDisplayUnit);
  const peakRows = spectrum.profiles.map(({ peak, series }) => (
    <tr key={series.id}>
      <th scope="row">{series.label}</th>
      <td>{formatTooltipValue(peak.x / 1e9, "GHz")}</td>
      <td>{powerTransform.formatValue(peak.y)}</td>
    </tr>
  ));

  return (
    <ChartSection
      footer={
        <table className="fm-analysis-plots__native-table fm-absorption-spectrum__peaks">
          <caption>Maximum sampled absorption by RF drive profile</caption>
          <thead>
            <tr>
              <th scope="col">Drive profile</th>
              <th scope="col">Frequency</th>
              <th scope="col">Absorbed power</th>
            </tr>
          </thead>
          <tbody>{peakRows}</tbody>
        </table>
      }
      legend={
        <ChartLegend
          ariaLabel="RF drive profiles"
          items={allSeries.map((series, index) => ({
            colorIndex: index,
            colorName: chartColorNameForIndex(index),
            id: series.id,
            label: series.label,
            latestValue: formatChartDisplayValue(series.points.at(-1)!.y, powerTransform),
            unit: powerTransform.displayUnit,
          }))}
          onSelectedSeriesIdsChange={(seriesIds) => setSelection({ spectrum, seriesIds })}
          selectedSeriesIds={visibleIds}
        />
      }
      subtitle={spectrum.fileName}
      status={{ primary: "Imported CSV", pointSummary: `${spectrum.sampleCount.toLocaleString("en-US")} samples per profile` }}
      title="Absorption Spectrum"
    >
      <EChartsSurface
        allSeries={allSeries}
        chartId={`rf-absorption:${spectrum.fileName}`}
        dataStatus="ready"
        displayUnits={displayUnits}
        exportProvenance={IMPORTED_SPECTRUM_PROVENANCE}
        series={visibleSeries}
        xAxisLabel="Frequency"
      />
    </ChartSection>
  );
}
