"use client";

import { useMemo, useState, type ReactNode } from "react";

import type { AntennaSourceSpectrumResource } from "@/kernel/api/apiTypes";
import {
  minMaxFinite,
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";
import { Button } from "@/shared/ui/Button";

import { AntennaSpectrumExport } from "./AntennaSpectrumExport";

const MAX_HEATMAP_ZOOM = 8;

export interface AntennaWavevectorHeatmapProps {
  values: ArrayLike<number>;
  nu: number;
  nv: number;
  extentUM: number;
  extentVM: number;
  scaleMode?: "linear" | "db";
  showCenterCut?: boolean;
  componentLabel?: string;
  /** Published wavevector axis k_u in SI rad/m (falls back to uniform FFT grid when omitted). */
  kU?: readonly number[];
  /** Published wavevector axis k_v in SI rad/m (falls back to uniform FFT grid when omitted). */
  kV?: readonly number[];
  /** Interleaved [Re, Im] complex amplitudes across components and cells (`amplitudes_re_im`). */
  amplitudes?: readonly number[];
  componentLabels?: readonly string[];
  amplitudeUnit?: string;
  waveVectorUnit?: string;
  powerUnit?: string;
  spectrum?: AntennaSourceSpectrumResource | null;
}

function formatSci(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toExponential(3)
    : "—";
}

/**
 * Renders 2D spatial Fourier spectrum |b_tilde(k_u, k_v)| on an ECharts `<canvas>`
 * heatmap backed by published `k_u`, `k_v`, `power`, and complex `amplitudes_re_im`
 * payloads, with interactive zoom, peak inspection, 1D u/v cuts, complex sample
 * readout, and streaming JSON export.
 */
export function AntennaWavevectorHeatmap({
  values,
  nu,
  nv,
  extentUM,
  extentVM,
  scaleMode = "linear",
  showCenterCut = true,
  componentLabel = "|b̃(ku, kv)|",
  kU,
  kV,
  amplitudes,
  componentLabels,
  amplitudeUnit = "A",
  waveVectorUnit = "rad/m",
  powerUnit = "A²",
  spectrum = null,
}: AntennaWavevectorHeatmapProps): ReactNode {
  const safeNu = Math.max(2, Math.floor(kU && kU.length >= 2 ? kU.length : nu));
  const safeNv = Math.max(2, Math.floor(kV && kV.length >= 2 ? kV.length : nv));
  const du = extentUM > 0 ? extentUM / safeNu : 50e-9;
  const dv = extentVM > 0 ? extentVM / safeNv : 50e-9;

  const {
    axisUValues,
    axisVValues,
    fullTuples,
    transformed,
    minVal,
    maxVal,
    peakFlatIndex,
    peakPower,
  } = useMemo(() => {
    const uVals: number[] = new Array(safeNu);
    const vVals: number[] = new Array(safeNv);
    if (kU && kU.length === safeNu) {
      for (let ix = 0; ix < safeNu; ix += 1) {
        uVals[ix] = kU[ix] ?? 0;
      }
    } else {
      const kMaxRadPerM = Math.PI / du;
      for (let ix = 0; ix < safeNu; ix += 1) {
        uVals[ix] = -kMaxRadPerM + (2 * kMaxRadPerM * ix) / Math.max(1, safeNu - 1);
      }
    }
    if (kV && kV.length === safeNv) {
      for (let iy = 0; iy < safeNv; iy += 1) {
        vVals[iy] = kV[iy] ?? 0;
      }
    } else {
      const kMaxRadPerM = Math.PI / dv;
      for (let iy = 0; iy < safeNv; iy += 1) {
        vVals[iy] = -kMaxRadPerM + (2 * kMaxRadPerM * iy) / Math.max(1, safeNv - 1);
      }
    }

    const extrema = minMaxFinite(values);
    const peak = extrema && extrema.max > 0 ? extrema.max : 1;
    const tuples: [number, number, number][] = new Array(safeNu * safeNv);
    const mappedValues = new Float64Array(safeNu * safeNv);

    let bestIndex = 0;
    let bestRaw = Number.NEGATIVE_INFINITY;
    let idx = 0;
    for (let iy = 0; iy < safeNv; iy += 1) {
      for (let ix = 0; ix < safeNu; ix += 1) {
        const raw = values[idx] ?? 0;
        const finite = Number.isFinite(raw) ? Math.max(0, raw) : 0;
        if (finite > bestRaw) {
          bestRaw = finite;
          bestIndex = idx;
        }
        const mapped =
          scaleMode === "db"
            ? Math.max(-60, 10 * Math.log10(Math.max(1e-6, finite / peak)))
            : finite;
        tuples[idx] = [ix, iy, mapped];
        mappedValues[idx] = mapped;
        idx += 1;
      }
    }

    const mappedExtrema = minMaxFinite(mappedValues) ?? { max: 1, min: 0 };

    return {
      axisUValues: uVals,
      axisVValues: vVals,
      fullTuples: tuples,
      maxVal:
        mappedExtrema.max === mappedExtrema.min
          ? mappedExtrema.min + 1
          : mappedExtrema.max,
      minVal: mappedExtrema.min,
      peakFlatIndex: bestIndex,
      peakPower: Number.isFinite(bestRaw) ? bestRaw : 0,
      transformed: mappedValues,
    };
  }, [du, dv, kU, kV, safeNu, safeNv, scaleMode, values]);

  const [zoomLevel, setZoomLevel] = useState(1);
  const [selectedFlatIndex, setSelectedFlatIndex] = useState<number | null>(null);

  const activeFlatIndex = useMemo(() => {
    const total = safeNu * safeNv;
    if (selectedFlatIndex !== null && selectedFlatIndex >= 0 && selectedFlatIndex < total) {
      return selectedFlatIndex;
    }
    return peakFlatIndex;
  }, [peakFlatIndex, safeNu, safeNv, selectedFlatIndex]);

  const selectedUIndex = activeFlatIndex % safeNu;
  const selectedVIndex = Math.floor(activeFlatIndex / safeNu);

  const { visibleULabels, visibleVLabels, visibleTuples, uCutLabels, uCutData, vCutLabels, vCutData } =
    useMemo(() => {
      const formatRadPerUm = (radPerM: number) => (radPerM / 1e6).toFixed(2);
      const uAllLabels = axisUValues.map(formatRadPerUm);
      const vAllLabels = axisVValues.map(formatRadPerUm);

      const uCut: number[] = new Array(safeNu);
      for (let ix = 0; ix < safeNu; ix += 1) {
        uCut[ix] = transformed[selectedVIndex * safeNu + ix] ?? 0;
      }
      const vCut: number[] = new Array(safeNv);
      for (let iy = 0; iy < safeNv; iy += 1) {
        vCut[iy] = transformed[iy * safeNu + selectedUIndex] ?? 0;
      }

      if (zoomLevel <= 1) {
        return {
          uCutData: uCut,
          uCutLabels: uAllLabels,
          vCutData: vCut,
          vCutLabels: vAllLabels,
          visibleTuples: fullTuples,
          visibleULabels: uAllLabels,
          visibleVLabels: vAllLabels,
        };
      }

      const spanU = Math.max(2, Math.ceil(safeNu / zoomLevel));
      const spanV = Math.max(2, Math.ceil(safeNv / zoomLevel));
      const startU = Math.max(
        0,
        Math.min(safeNu - spanU, selectedUIndex - Math.floor(spanU / 2)),
      );
      const startV = Math.max(
        0,
        Math.min(safeNv - spanV, selectedVIndex - Math.floor(spanV / 2)),
      );
      const zoomedTuples: [number, number, number][] = [];
      for (let iy = 0; iy < spanV; iy += 1) {
        for (let ix = 0; ix < spanU; ix += 1) {
          const val = transformed[(startV + iy) * safeNu + (startU + ix)] ?? 0;
          zoomedTuples.push([ix, iy, val]);
        }
      }
      return {
        uCutData: uCut,
        uCutLabels: uAllLabels,
        vCutData: vCut,
        vCutLabels: vAllLabels,
        visibleTuples: zoomedTuples,
        visibleULabels: uAllLabels.slice(startU, startU + spanU),
        visibleVLabels: vAllLabels.slice(startV, startV + spanV),
      };
    }, [
      axisUValues,
      axisVValues,
      fullTuples,
      safeNu,
      safeNv,
      selectedUIndex,
      selectedVIndex,
      transformed,
      zoomLevel,
    ]);

  const heatmapOptionBuilder = useMemo(
    () => (palette: ResolvedChartThemePalette) => ({
      animation: false,
      grid: { bottom: 38, left: 46, right: 18, top: 14 },
      series: [
        {
          data: visibleTuples,
          emphasis: {
            itemStyle: { borderColor: palette.textPrimary, borderWidth: 1 },
          },
          name: componentLabel,
          progressive: 0,
          type: "heatmap" as const,
        },
      ],
      tooltip: {
        backgroundColor: palette.tooltipBackground,
        borderColor: palette.borderSubtle,
        position: "top" as const,
        textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
      },
      visualMap: {
        calculable: false,
        inRange: {
          color: [
            palette.panelBackground,
            palette.info,
            palette.accent,
            palette.warning,
          ],
        },
        max: maxVal,
        min: minVal,
        orient: "horizontal" as const,
        show: false,
      },
      xAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        data: visibleULabels,
        name: "k_u [rad/µm]",
        nameGap: 22,
        nameLocation: "middle" as const,
        nameTextStyle: { color: palette.textSecondary, fontSize: palette.fontSize },
        type: "category" as const,
      },
      yAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        data: visibleVLabels,
        name: "k_v [rad/µm]",
        nameTextStyle: { color: palette.textSecondary, fontSize: palette.fontSize },
        type: "category" as const,
      },
    }),
    [componentLabel, maxVal, minVal, visibleTuples, visibleULabels, visibleVLabels],
  );

  const uCutOptionBuilder = useMemo(
    () => (palette: ResolvedChartThemePalette) => ({
      animation: false,
      grid: { bottom: 26, left: 46, right: 14, top: 12 },
      series: [
        {
          areaStyle: { color: palette.fieldBackground },
          data: uCutData,
          itemStyle: { color: palette.accent },
          lineStyle: { color: palette.accent, width: 1.75 },
          name: "u cut",
          showSymbol: false,
          type: "line" as const,
        },
      ],
      tooltip: {
        backgroundColor: palette.tooltipBackground,
        borderColor: palette.borderSubtle,
        textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
        trigger: "axis" as const,
      },
      xAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        data: uCutLabels,
        type: "category" as const,
      },
      yAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        splitLine: { lineStyle: { color: palette.borderSubtle } },
        type: "value" as const,
      },
    }),
    [uCutData, uCutLabels],
  );

  const vCutOptionBuilder = useMemo(
    () => (palette: ResolvedChartThemePalette) => ({
      animation: false,
      grid: { bottom: 26, left: 46, right: 14, top: 12 },
      series: [
        {
          areaStyle: { color: palette.fieldBackground },
          data: vCutData,
          itemStyle: { color: palette.info },
          lineStyle: { color: palette.info, width: 1.75 },
          name: "v cut",
          showSymbol: false,
          type: "line" as const,
        },
      ],
      tooltip: {
        backgroundColor: palette.tooltipBackground,
        borderColor: palette.borderSubtle,
        textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
        trigger: "axis" as const,
      },
      xAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        data: vCutLabels,
        type: "category" as const,
      },
      yAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        splitLine: { lineStyle: { color: palette.borderSubtle } },
        type: "value" as const,
      },
    }),
    [vCutData, vCutLabels],
  );

  const peakU = axisUValues[peakFlatIndex % safeNu];
  const peakV = axisVValues[Math.floor(peakFlatIndex / safeNu)];
  const selectedU = axisUValues[selectedUIndex];
  const selectedV = axisVValues[selectedVIndex];
  const selectedRawPower = Number(values[activeFlatIndex] ?? 0);

  const complexRows = useMemo(() => {
    if (!amplitudes || !componentLabels || componentLabels.length === 0) return [];
    const cellCount = safeNu * safeNv;
    if (amplitudes.length < 2 * componentLabels.length * cellCount) return [];
    return componentLabels.map((label, compIdx) => {
      const offset = 2 * (compIdx * cellCount + activeFlatIndex);
      const re = amplitudes[offset] ?? 0;
      const im = amplitudes[offset + 1] ?? 0;
      const mag = Math.hypot(re, im);
      const phaseText =
        re === 0 && im === 0
          ? "0 (zero amplitude)"
          : Math.atan2(im, re).toFixed(4);
      return {
        ampText: formatSci(mag),
        imText: formatSci(im),
        label,
        phaseText,
        reText: formatSci(re),
      };
    });
  }, [activeFlatIndex, amplitudes, componentLabels, safeNu, safeNv]);

  const exportPowerArray = useMemo(() => {
    if (!spectrum || !amplitudes || !kU || !kV) return null;
    return Array.from({ length: values.length }, (_, i) => Number(values[i] ?? 0));
  }, [amplitudes, kU, kV, spectrum, values]);

  return (
    <div className="fm-inspector-stack" data-slot="antenna-wavevector-heatmap">
      <div
        aria-label="Source spectrum actions"
        className="fm-inspector-inline-actions"
        role="group"
      >
        {spectrum && amplitudes && kU && kV && exportPowerArray ? (
          <AntennaSpectrumExport
            amplitudes={amplitudes}
            kU={kU}
            kV={kV}
            power={exportPowerArray}
            spectrum={spectrum}
          />
        ) : null}
        <Button
          disabled={zoomLevel === 1}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => setZoomLevel((current) => Math.max(1, current / 2))}
        >
          Zoom out
        </Button>
        <span aria-live="polite">Zoom {zoomLevel}×</span>
        <Button
          disabled={zoomLevel >= MAX_HEATMAP_ZOOM}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() =>
            setZoomLevel((current) => Math.min(MAX_HEATMAP_ZOOM, current * 2))
          }
        >
          Zoom in
        </Button>
        <Button
          disabled={zoomLevel === 1}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => setZoomLevel(1)}
        >
          Reset zoom
        </Button>
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => setSelectedFlatIndex(peakFlatIndex)}
        >
          Inspect peak
        </Button>
      </div>

      <ScientificEChart
        ariaLabel={`2D wavevector excitation spectrum ${componentLabel} (${safeNu}x${safeNv})`}
        height={220}
        optionBuilder={heatmapOptionBuilder}
      />

      <div
        aria-label="Source spectrum peak and selected sample"
        className="fm-antenna-spectrum__summary"
        role="group"
      >
        <span>
          Peak |H̃|² = {formatSci(peakPower)} {powerUnit} at k = ({formatSci(peakU)},{" "}
          {formatSci(peakV)}) {waveVectorUnit}
        </span>
        <span>
          Selected ({selectedUIndex}, {selectedVIndex}): k_u = {formatSci(selectedU)}{" "}
          {waveVectorUnit}, k_v = {formatSci(selectedV)} {waveVectorUnit}, |H̃|² ={" "}
          {formatSci(selectedRawPower)} {powerUnit}
        </span>
      </div>

      {showCenterCut ? (
        <div
          aria-label="Selected source spectrum cross-sections"
          className="fm-inspector-stack"
          role="group"
        >
          <div>
            <p className="fm-inspector-hint">
              1D u-cut at k_v = {formatSci(selectedV)} {waveVectorUnit} ({safeNu} samples)
            </p>
            <ScientificEChart
              ariaLabel={`1D u-cut along k_u at k_v = ${formatSci(selectedV)}`}
              height={115}
              optionBuilder={uCutOptionBuilder}
            />
          </div>
          <div>
            <p className="fm-inspector-hint">
              1D v-cut at k_u = {formatSci(selectedU)} {waveVectorUnit} ({safeNv} samples)
            </p>
            <ScientificEChart
              ariaLabel={`1D v-cut along k_v at k_u = ${formatSci(selectedU)}`}
              height={115}
              optionBuilder={vCutOptionBuilder}
            />
          </div>
        </div>
      ) : null}

      {complexRows.length > 0 ? (
        <div className="fm-antenna-spectrum__complex-sample">
          <table>
            <caption>Complex source amplitudes at selected sample</caption>
            <thead>
              <tr>
                <th scope="col">Component</th>
                <th scope="col">Re [{amplitudeUnit}]</th>
                <th scope="col">Im [{amplitudeUnit}]</th>
                <th scope="col">Amplitude [{amplitudeUnit}]</th>
                <th scope="col">Phase [rad]</th>
              </tr>
            </thead>
            <tbody>
              {complexRows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">H_{row.label}</th>
                  <td>{row.reText}</td>
                  <td>{row.imText}</td>
                  <td>{row.ampText}</td>
                  <td>{row.phaseText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
