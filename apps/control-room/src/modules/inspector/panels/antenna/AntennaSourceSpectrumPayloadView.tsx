"use client";

import { useId, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  AntennaSourceSpectrumResource,
  BinaryResourceResult,
} from "@/kernel/api/apiTypes";
import { antennaSpectrumPayloadByteLengths } from "@/kernel/api/codecs/antennaSpectrumManifestCodec";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import {
  antennaSpectrumPayloadEtag,
  useAntennaSourceSpectrumPayloadResource,
} from "@/kernel/resources/antennaResources";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";
import { Button } from "@/shared/ui/Button";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import { useAntennaSpectrumGridCompatibility, type AntennaSpectrumKGrid } from "./useAntennaSpectrumGridCompatibility";
import { AntennaSpectrumExport } from "./AntennaSpectrumExport";

const MAX_AXIS_CELLS = 64;
const MAX_CUT_POINTS = 512;
const MAX_HEATMAP_ZOOM = 8;
const MAX_DISPLAY_PAYLOAD_BYTES = 64 * 1024 * 1024;

type SpectrumPowerScale = "linear" | "log";

interface SpectrumPayloadViewProps {
  outputId: string;
  spectrum: AntennaSourceSpectrumResource;
  expectedKGrid?: AntennaSpectrumKGrid;
}

interface DecodedPayloads {
  amplitudes: number[];
  kU: number[];
  kV: number[];
  power: number[];
}

interface HeatmapCell {
  kUIndex: number;
  kVIndex: number;
  power: number;
}

interface SpectrumAxisRange {
  minimum: number;
  maximum: number;
}

interface SpectrumCutPoint {
  index: number;
  waveVector: number;
  power: number;
}

interface SpectrumCut {
  direction: "u" | "v";
  axisName: "k_u" | "k_v";
  fixedValue: number;
  axisRange: SpectrumAxisRange;
  points: SpectrumCutPoint[];
  selectedIndex: number;
  sampleCount: number;
  zeroCount: number;
}

type SpectrumPayloadResource = Pick<
  ResourceResult<BinaryResourceResult<ArrayBuffer> | null>,
  "data" | "error" | "refreshError" | "status"
>;

function useSpectrumPayloadSnapshot({ data, error, refreshError, status }: SpectrumPayloadResource) {
  return useMemo(() => ({ data, error, refreshError, status }), [data, error, refreshError, status]);
}

export function AntennaSourceSpectrumPayloadView({
  outputId,
  spectrum,
  expectedKGrid,
}: SpectrumPayloadViewProps) {
  const [requestedPowerScale, setRequestedPowerScale] = useState<SpectrumPowerScale>("linear");
  const manifest = useMemo(() => {
    try {
      const lengths = antennaSpectrumPayloadByteLengths(spectrum);
      if (lengths.total > MAX_DISPLAY_PAYLOAD_BYTES) throw new Error("Antenna spectrum exceeds the 64 MiB interactive display budget. No binary payload was requested.");
      return {
        kind: "ready" as const,
        lengths,
        etags: {
          k_u_rad_per_m: antennaSpectrumPayloadEtag(spectrum, "k_u_rad_per_m"),
          k_v_rad_per_m: antennaSpectrumPayloadEtag(spectrum, "k_v_rad_per_m"),
          amplitudes_re_im: antennaSpectrumPayloadEtag(spectrum, "amplitudes_re_im"),
          power: antennaSpectrumPayloadEtag(spectrum, "power"),
        },
      };
    } catch (error) {
      return { kind: "error" as const,
        error: error instanceof Error ? error : new Error("spectrum manifest validation failed") };
    }
  }, [spectrum]);
  const gridCompatibility = useAntennaSpectrumGridCompatibility(spectrum, expectedKGrid, manifest.kind === "ready");
  const payloadsEnabled = manifest.kind === "ready" && gridCompatibility.kind === "ready";
  const kU = useSpectrumPayloadSnapshot(useAntennaSourceSpectrumPayloadResource(outputId, "k_u_rad_per_m", {
    enabled: payloadsEnabled,
    expectedEtag: manifest.kind === "ready" ? manifest.etags.k_u_rad_per_m : undefined,
    maxResponseBytes: manifest.kind === "ready" ? manifest.lengths.payloads.k_u_rad_per_m : undefined,
  }));
  const kV = useSpectrumPayloadSnapshot(useAntennaSourceSpectrumPayloadResource(outputId, "k_v_rad_per_m", {
    enabled: payloadsEnabled,
    expectedEtag: manifest.kind === "ready" ? manifest.etags.k_v_rad_per_m : undefined,
    maxResponseBytes: manifest.kind === "ready" ? manifest.lengths.payloads.k_v_rad_per_m : undefined,
  }));
  const amplitudes = useSpectrumPayloadSnapshot(useAntennaSourceSpectrumPayloadResource(
    outputId,
    "amplitudes_re_im",
    {
      enabled: payloadsEnabled,
      expectedEtag: manifest.kind === "ready" ? manifest.etags.amplitudes_re_im : undefined,
      maxResponseBytes: manifest.kind === "ready" ? manifest.lengths.payloads.amplitudes_re_im : undefined,
    },
  ));
  const power = useSpectrumPayloadSnapshot(useAntennaSourceSpectrumPayloadResource(outputId, "power", {
    enabled: payloadsEnabled,
    expectedEtag: manifest.kind === "ready" ? manifest.etags.power : undefined,
    maxResponseBytes: manifest.kind === "ready" ? manifest.lengths.payloads.power : undefined,
  }));
  const payloads = useMemo(() => {
    if (!payloadsEnabled) return { kind: "pending" as const };
    const decoded = decodePayloads(kU, kV, amplitudes, power);
    if (decoded.kind !== "ready") return decoded;
    const integrityError = validatePayloads(decoded.value, spectrum, expectedKGrid);
    if (integrityError) return { kind: "integrity-error" as const, error: integrityError };
    return {
      ...decoded,
      cells: heatmapCells(decoded.value.kU, decoded.value.kV, decoded.value.power),
      extrema: spectrumPowerExtrema(decoded.value.power),
      rangeU: spectrumPowerExtrema(decoded.value.kU),
      rangeV: spectrumPowerExtrema(decoded.value.kV),
    };
  }, [amplitudes, kU, kV, payloadsEnabled, power, spectrum, expectedKGrid]);

  if (manifest.kind === "error") {
    return (
      <section className="fm-antenna-spectrum" aria-label="Antenna source spectrum payload">
        <p className="fm-antenna-spectrum__status fm-antenna-spectrum__status--error" role="alert">
          FFT manifest unavailable: {formatPayloadError(manifest.error)}
        </p>
      </section>
    );
  }

  if (gridCompatibility.kind !== "ready") {
    return <section className="fm-antenna-spectrum" aria-label="Antenna source spectrum payload">
      <p className={gridCompatibility.kind === "error" ? "fm-antenna-spectrum__status fm-antenna-spectrum__status--error" : "fm-antenna-spectrum__status"} role={gridCompatibility.kind === "error" ? "alert" : "status"}>
        {gridCompatibility.kind === "error" ? `FFT configuration unavailable: ${gridCompatibility.error}` : "Verifying authored wave-vector grid…"}
      </p>
    </section>;
  }

  if (payloads.kind === "pending") {
    return (
      <section className="fm-antenna-spectrum" aria-label="Antenna source spectrum payload">
        <p className="fm-antenna-spectrum__status" role="status">
          Loading binary FFT payloads…
        </p>
      </section>
    );
  }
  if (payloads.kind === "error") {
    return (
      <section className="fm-antenna-spectrum" aria-label="Antenna source spectrum payload">
        <p className="fm-antenna-spectrum__status fm-antenna-spectrum__status--error" role="alert">
          FFT payload unavailable: {formatPayloadError(payloads.error)}
        </p>
      </section>
    );
  }

  if (payloads.kind === "integrity-error") {
    return (
      <section className="fm-antenna-spectrum" aria-label="Antenna source spectrum payload">
        <p className="fm-antenna-spectrum__status fm-antenna-spectrum__status--error" role="alert">
          FFT payload integrity error: {payloads.error}
        </p>
      </section>
    );
  }

  const { cells, extrema, rangeU, rangeV } = payloads;
  const peak = extrema ? { index: extrema.peakIndex, value: extrema.maximum } : null;
  const peakKU = peak ? payloads.value.kU[peak.index % payloads.value.kU.length] : null;
  const peakKV = peak
    ? payloads.value.kV[Math.floor(peak.index / payloads.value.kU.length)]
    : null;
  const renderedCellCount = cells.length;
  const isBinned = payloads.value.kU.length > MAX_AXIS_CELLS ||
    payloads.value.kV.length > MAX_AXIS_CELLS;
  const powerUnit = spectrum.payloads?.power.unit ?? `(${spectrum.amplitude_unit})^2`;
  const transverse = spectrum.component === "transverse";
  const componentLabel = transverse ? "H transverse (x, y, z)" : spectrum.component === "vector_power" ? "H vector (x, y, z)" : `H_${spectrum.component}`;
  const powerExpression = transverse ? "|H\u22a5_x|² + |H\u22a5_y|² + |H\u22a5_z|²" : spectrum.component === "vector_power"
    ? "|H_x|² + |H_y|² + |H_z|²" : `|H_${spectrum.component}|²`;
  const normalizationLabel = spectrum.normalization === "integral_si" ? "Integral SI" : "Unitary discrete";
  const hasLogScale = extrema !== null && extrema.minimumPositive !== null &&
    extrema.maximum > extrema.minimum;
  const powerScale = requestedPowerScale === "log" && hasLogScale ? "log" : "linear";

  return (
    <section className="fm-antenna-spectrum" aria-label="Antenna source spectrum payload">
      <div className="fm-antenna-spectrum__header">
        <div>
          <h3 className="fm-antenna-spectrum__title">Source FFT · |H̃|² · {componentLabel}</h3>
          <p className="fm-antenna-spectrum__subtitle">
            {powerExpression} at (k<sub>u</sub>, k<sub>v</sub>) · {normalizationLabel} normalization
            {" · "}per 1 A port-current basis; drive waveform not applied
            {" · "}squared field magnitude, not watts
          </p>
        </div>
        <span className="fm-antenna-spectrum__badge" data-status="ready">
          {isBinned ? "max-pooled" : "full grid"}
        </span>
      </div>
      {extrema ? <SpectrumPowerScale minimum={extrema.minimum} minimumPositive={extrema.minimumPositive}
        maximum={extrema.maximum} scale={powerScale} onScaleChange={setRequestedPowerScale} unit={powerUnit} /> : null}
      <SpectrumPowerGrid key={outputId} cells={cells} kU={payloads.value.kU} kV={payloads.value.kV}
        power={payloads.value.power} uRange={rangeU} vRange={rangeV}
        amplitudes={payloads.value.amplitudes} componentLabels={spectrum.component_labels} amplitudeUnit={spectrum.amplitude_unit}
        waveVectorUnit={spectrum.wave_vector_unit} powerUnit={powerUnit} powerScale={powerScale}
        powerMinimum={extrema?.minimum ?? 0} powerMaximum={extrema?.maximum ?? 0}
        minimumPositivePower={extrema?.minimumPositive ?? null}
        componentPrefix={transverse ? "H\u22a5" : "H"} componentLabel={componentLabel} isBinned={isBinned} peakIndex={extrema?.peakIndex ?? -1}>
        <AntennaSpectrumExport spectrum={spectrum} amplitudes={payloads.value.amplitudes}
          kU={payloads.value.kU} kV={payloads.value.kV} power={payloads.value.power} />
      </SpectrumPowerGrid>
      <div className="fm-antenna-spectrum__axes" aria-label="Source spectrum axes">
        <span>u: {Math.min(MAX_AXIS_CELLS, payloads.value.kU.length)} / {payloads.value.kU.length} · {spectrum.wave_vector_unit}</span>
        <span>v: {Math.min(MAX_AXIS_CELLS, payloads.value.kV.length)} / {payloads.value.kV.length} · {spectrum.wave_vector_unit}</span>
        <span>k_u range: {formatScientific(rangeU?.minimum)} … {formatScientific(rangeU?.maximum)} {spectrum.wave_vector_unit}</span>
        <span>k_v range: {formatScientific(rangeV?.minimum)} … {formatScientific(rangeV?.maximum)} {spectrum.wave_vector_unit}</span>
        <span>cells: {renderedCellCount}{isBinned ? " (max-pooled)" : ""}</span>
      </div>
      <div className="fm-antenna-spectrum__summary" aria-label="Source spectrum peak">
        <span>
          Peak {peak ? formatScientific(peak.value) : "unavailable"} {powerUnit}
        </span>
        <span>
          k=({peakKU === null ? "—" : formatScientific(peakKU)}, {peakKV === null ? "—" : formatScientific(peakKV)}) {spectrum.wave_vector_unit}
        </span>
      </div>
    </section>
  );
}

function spectrumPowerExtrema(power: readonly number[]): (SpectrumAxisRange & {
  minimumPositive: number | null;
  peakIndex: number;
}) | null {
  let minimum = Infinity;
  let minimumPositive = Infinity;
  let maximum = -Infinity;
  let peakIndex = -1;
  for (let index = 0; index < power.length; index += 1) {
    const value = power[index]!;
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    if (value > 0) minimumPositive = Math.min(minimumPositive, value);
    if (value > maximum) { maximum = value; peakIndex = index; }
  }
  return peakIndex < 0 ? null : {
    minimum,
    minimumPositive: Number.isFinite(minimumPositive) ? minimumPositive : null,
    maximum,
    peakIndex,
  };
}

function SpectrumPowerScale({
  minimum,
  minimumPositive,
  maximum,
  scale,
  onScaleChange,
  unit,
}: {
  minimum: number;
  minimumPositive: number | null;
  maximum: number;
  scale: SpectrumPowerScale;
  onScaleChange: (scale: SpectrumPowerScale) => void;
  unit: string;
}) {
  const hasLogScale = minimumPositive !== null && maximum > minimum;
  const displayMinimum = scale === "log" && minimumPositive === maximum && minimum < maximum
    ? 0
    : scale === "log" ? minimumPositive ?? minimum : minimum;
  return <div className="fm-antenna-spectrum__scale" role="group" aria-label="Source spectrum color scale">
    <div className="fm-antenna-spectrum__scale-copy">
      {minimum === maximum ? <span>Uniform squared field magnitude: {formatScientific(minimum)} {unit}</span> : <>
        <span>{scale === "log" ? "Logarithmic squared-field scale · zero maps to the minimum color" : "Linear squared-field scale"}</span>
        <span>{formatScientific(displayMinimum)} {unit}</span>
        <span className="fm-antenna-spectrum__scale-bar" aria-hidden="true" />
        <span>{formatScientific(maximum)} {unit}</span>
      </>}
      {!hasLogScale ? <span>{minimumPositive === null
        ? "Log scale unavailable: no positive squared-field values."
        : "Log scale unavailable: positive squared-field values are uniform."}</span> : null}
    </div>
    <SegmentedControl<SpectrumPowerScale>
      aria-label="Squared-field display scale"
      columns={2}
      options={[
        { label: "Linear", value: "linear" },
        { disabled: !hasLogScale, label: "Log", value: "log" },
      ]}
      value={scale}
      onValueChange={onScaleChange}
    />
  </div>;
}

function spectrumGridTarget(key: string, index: number, columns: number, count: number, wholeGrid = false): number | null {
  const rowStart = Math.floor(index / columns) * columns;
  const rowEnd = Math.min(count - 1, rowStart + columns - 1);
  switch (key) {
    case "ArrowLeft": return Math.max(rowStart, index - 1);
    case "ArrowRight": return Math.min(rowEnd, index + 1);
    case "ArrowUp": return index >= columns ? index - columns : index;
    case "ArrowDown": return index + columns < count ? index + columns : index;
    case "Home": return wholeGrid ? 0 : rowStart;
    case "End": return wholeGrid ? count - 1 : rowEnd;
    default: return null;
  }
}

/** Selection stays local: keyboard inspection never redecodes payloads or refetches resources. */
function SpectrumPowerGrid({
  cells,
  kU,
  kV,
  power,
  uRange,
  vRange,
  amplitudes,
  componentLabels,
  amplitudeUnit,
  waveVectorUnit,
  powerUnit,
  powerScale,
  powerMinimum,
  powerMaximum,
  minimumPositivePower,
  componentPrefix,
  componentLabel,
  isBinned,
  peakIndex,
  children,
}: {
  cells: readonly HeatmapCell[]; kU: readonly number[]; kV: readonly number[];
  power: readonly number[]; uRange: SpectrumAxisRange | null; vRange: SpectrumAxisRange | null;
  amplitudes: readonly number[]; componentLabels: readonly string[]; amplitudeUnit: string;
  waveVectorUnit: string; powerUnit: string; powerScale: SpectrumPowerScale;
  powerMinimum: number; powerMaximum: number; minimumPositivePower: number | null;
  componentPrefix: string; componentLabel: string; isBinned: boolean; peakIndex: number; children: ReactNode;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(1);
  const helpId = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  const peakCellIndex = useMemo(() => cells.findIndex(cell =>
    cell.kVIndex * kU.length + cell.kUIndex === peakIndex), [cells, kU.length, peakIndex]);
  const columns = Math.min(MAX_AXIS_CELLS, kU.length);
  const rows = Math.ceil(cells.length / columns);
  const selectedIndex = Math.min(activeIndex, cells.length - 1);
  const selected = cells[selectedIndex];
  const cuts = useMemo(() => {
    if (!selected || !uRange || !vRange) return null;
    return [
      buildSpectrumCut("u", "k_u", kV[selected.kVIndex]!, kU, uRange,
        selected.kUIndex, (index) => power[selected.kVIndex * kU.length + index]!),
      buildSpectrumCut("v", "k_v", kU[selected.kUIndex]!, kV, vRange,
        selected.kVIndex, (index) => power[index * kU.length + selected.kUIndex]!),
    ];
  }, [kU, kV, power, selected, uRange, vRange]);
  return <>
    <div className="fm-antenna-spectrum__axes" role="group" aria-label="Source spectrum actions">
      {children}
      <Button size="sm" variant="secondary" disabled={zoomLevel === 1}
        onClick={() => setZoomLevel((current) => Math.max(1, current / 2))}>
        Zoom out
      </Button>
      <span aria-live="polite">Zoom {zoomLevel}×</span>
      <Button size="sm" variant="secondary" disabled={zoomLevel === MAX_HEATMAP_ZOOM}
        onClick={() => setZoomLevel((current) => Math.min(MAX_HEATMAP_ZOOM, current * 2))}>
        Zoom in
      </Button>
      <Button size="sm" variant="secondary" disabled={zoomLevel === 1}
        onClick={() => setZoomLevel(1)}>
        Reset zoom
      </Button>
      <Button size="sm" variant="secondary" disabled={peakCellIndex < 0} onClick={() => {
        gridRef.current?.querySelector<HTMLElement>(`[data-spectrum-cell-index="${peakCellIndex}"]`)?.focus();
      }}>Inspect peak</Button>
    </div>
    <p id={helpId} className="fm-antenna-spectrum__subtitle">
      Arrow keys inspect cells. Home/End move within a row; Ctrl+Home/End move to the grid edges.
      Cells follow the published k-grid order. Cell spacing represents sample indices, not k-distance; pooled cells report their strongest sample.
      Zoom follows the selected cell where the map bounds allow; all cells remain reachable with the keyboard.
    </p>
    <div className="fm-antenna-spectrum__heatmap-viewport">
      <div ref={gridRef} className="fm-antenna-spectrum__heatmap" role="grid"
        aria-label={`${cells.length} source-spectrum squared-field cells`} aria-describedby={helpId}
        aria-rowcount={rows} aria-colcount={columns}
        style={{
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
          transform: spectrumGridTransform(zoomLevel, selectedIndex, columns, rows),
        }}>
        {Array.from({ length: rows }, (_, row) => <div role="row" aria-rowindex={row + 1}
          className="fm-antenna-spectrum__row" key={row}
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {cells.slice(row * columns, (row + 1) * columns).map((cell, column) => {
            const index = row * columns + column;
            const label = `${isBinned ? "bin maximum at " : ""}k_u=${formatScientific(kU[cell.kUIndex])} ${waveVectorUnit}, k_v=${formatScientific(kV[cell.kVIndex])} ${waveVectorUnit}, |H̃|²=${formatScientific(cell.power)} ${powerUnit}`;
            return <span role="gridcell" key={`${cell.kVIndex}:${cell.kUIndex}`}
              className="fm-antenna-spectrum__cell" aria-colindex={column + 1}
              aria-label={label} title={label} aria-selected={index === selectedIndex}
              data-spectrum-cell-index={index} tabIndex={index === selectedIndex ? 0 : -1}
              onFocus={() => setActiveIndex(index)} onClick={(event) => event.currentTarget.focus()}
              onKeyDown={(event) => {
                const next = spectrumGridTarget(event.key, index, columns, cells.length, event.ctrlKey || event.metaKey);
                if (next === null) return;
                event.preventDefault();
                event.currentTarget.closest('[role="grid"]')
                  ?.querySelector<HTMLElement>(`[data-spectrum-cell-index="${next}"]`)?.focus();
              }}
              style={{ background: `color-mix(in srgb, var(--fm-accent) ${8 + 92 * spectrumPowerFraction(cell.power, powerMinimum, powerMaximum, minimumPositivePower, powerScale)}%, var(--fm-bg-panel-raised))` }} />;
          })}
        </div>)}
      </div>
    </div>
    <div className="fm-antenna-spectrum__sample" role="group" aria-label="Selected source spectrum sample">
      <span>{isBinned ? "Bin maximum" : "Selected sample"} · {componentLabel}</span>
      <span>k_u {formatScientific(selected ? kU[selected.kUIndex] : undefined)} {waveVectorUnit}</span>
      <span>k_v {formatScientific(selected ? kV[selected.kVIndex] : undefined)} {waveVectorUnit}</span>
      <span>|H̃|² {formatScientific(selected?.power)} {powerUnit}</span>
    </div>
    {cuts ? <div className="fm-antenna-spectrum__cuts" aria-label="Selected source spectrum cross-sections">
      {cuts.map((cut) => <SpectrumCutFigure key={cut.direction} cut={cut}
        waveVectorUnit={waveVectorUnit} powerUnit={powerUnit} scale={powerScale}
        powerMinimum={powerMinimum} powerMaximum={powerMaximum} minimumPositivePower={minimumPositivePower} />)}
    </div> : null}
    {selected ? <div className="fm-antenna-spectrum__complex-sample">
      <table>
        <caption>Complex source amplitudes at selected sample</caption>
        <thead><tr>
          <th scope="col">Component</th>
          <th scope="col">Re [{amplitudeUnit}]</th>
          <th scope="col">Im [{amplitudeUnit}]</th>
          <th scope="col">Amplitude [{amplitudeUnit}]</th>
          <th scope="col">Phase [rad]</th>
        </tr></thead>
        <tbody>{componentLabels.map((label, component) => {
          const sample = selected.kVIndex * kU.length + selected.kUIndex;
          const offset = 2 * (component * kU.length * kV.length + sample);
          const re = amplitudes[offset]!, im = amplitudes[offset + 1]!;
          return <tr key={label}>
            <th scope="row">{componentPrefix}_{label}</th>
            <td>{formatScientific(re)}</td><td>{formatScientific(im)}</td>
            <td>{formatScientific(Math.hypot(re, im))}</td>
            <td>{re === 0 && im === 0 ? "undefined (zero amplitude)" : Math.atan2(im, re).toFixed(4)}</td>
          </tr>;
        })}</tbody>
      </table>
      <p className="fm-antenna-spectrum__subtitle">Phase is arg(Re + i Im) in the published Fourier convention; undefined at zero amplitude. Values use the same per-ampere basis and normalization as the map.</p>
    </div> : null}
  </>;
}

function buildSpectrumCut(
  direction: "u" | "v",
  axisName: "k_u" | "k_v",
  fixedValue: number,
  axisValues: readonly number[],
  axisRange: SpectrumAxisRange,
  selectedIndex: number,
  powerAt: (index: number) => number,
): SpectrumCut {
  const sampleCount = axisValues.length;
  const selected = Math.max(0, Math.min(sampleCount - 1, selectedIndex));
  const indexes = new Set<number>();
  let zeroCount = 0;
  if (sampleCount <= MAX_CUT_POINTS) {
    for (let index = 0; index < sampleCount; index += 1) {
      indexes.add(index);
      if (powerAt(index) === 0) zeroCount += 1;
    }
  } else {
    indexes.add(0);
    indexes.add(sampleCount - 1);
    indexes.add(selected);
    zeroCount += Number(powerAt(0) === 0) + Number(powerAt(sampleCount - 1) === 0);
    const bucketCount = Math.floor((MAX_CUT_POINTS - 3) / 2);
    const interiorCount = sampleCount - 2;
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const start = 1 + Math.floor(bucket * interiorCount / bucketCount);
      const end = 1 + Math.floor((bucket + 1) * interiorCount / bucketCount);
      let minimumIndex = start;
      let maximumIndex = start;
      let minimumValue = Number.POSITIVE_INFINITY;
      let maximumValue = Number.NEGATIVE_INFINITY;
      for (let index = start; index < end; index += 1) {
        const value = powerAt(index);
        if (value === 0) zeroCount += 1;
        if (value < minimumValue) {
          minimumValue = value;
          minimumIndex = index;
        }
        if (value > maximumValue) {
          maximumValue = value;
          maximumIndex = index;
        }
      }
      indexes.add(minimumIndex);
      indexes.add(maximumIndex);
    }
  }
  const points = Array.from(indexes).sort((a, b) => a - b).map((index) => ({
    index,
    waveVector: axisValues[index]!,
    power: powerAt(index),
  }));
  return {
    direction,
    axisName,
    fixedValue,
    axisRange,
    points,
    selectedIndex: selected,
    sampleCount,
    zeroCount,
  };
}

function spectrumPowerFraction(
  value: number,
  minimum: number,
  maximum: number,
  minimumPositive: number | null,
  scale: SpectrumPowerScale,
): number {
  if (scale === "log") {
    if (value <= 0 || minimumPositive === null) return 0;
    const minimumLog = Math.log10(minimumPositive);
    const maximumLog = Math.log10(maximum);
    return maximumLog > minimumLog
      ? Math.max(0, Math.min(1, (Math.log10(value) - minimumLog) / (maximumLog - minimumLog)))
      : 1;
  }
  const range = maximum - minimum;
  return range > 0 ? Math.max(0, Math.min(1, (value - minimum) / range)) : 0;
}

function SpectrumCutFigure({
  cut,
  waveVectorUnit,
  powerUnit,
  scale,
  powerMinimum,
  powerMaximum,
  minimumPositivePower,
}: {
  cut: SpectrumCut;
  waveVectorUnit: string;
  powerUnit: string;
  scale: SpectrumPowerScale;
  powerMinimum: number;
  powerMaximum: number;
  minimumPositivePower: number | null;
}) {
  const captionId = useId();
  const plot = { left: 52, right: 350, top: 12, bottom: 112 };
  const minimumX = cut.axisRange.minimum;
  const maximumX = cut.axisRange.maximum;
  const xRange = maximumX - minimumX;
  const xFor = (value: number) => Number.isFinite(xRange) && xRange > 0
    ? plot.left + (value - minimumX) / xRange * (plot.right - plot.left)
    : (plot.left + plot.right) / 2;
  const displayMinimum = scale === "log" && minimumPositivePower === powerMaximum &&
    powerMinimum < powerMaximum
    ? 0
    : scale === "log" ? minimumPositivePower ?? powerMinimum : powerMinimum;
  const yFor = (value: number) => plot.bottom - spectrumPowerFraction(
    value, powerMinimum, powerMaximum, minimumPositivePower, scale,
  ) * (plot.bottom - plot.top);
  const path = spectrumCutPath(cut.points, xFor, yFor, scale);
  const markerPoints = cut.points.filter((point, index) => {
    if (point.index === cut.selectedIndex && (scale === "linear" || point.power > 0)) return true;
    return scale === "log" && point.power > 0 &&
      (index === 0 || cut.points[index - 1]!.power === 0) &&
      (index === cut.points.length - 1 || cut.points[index + 1]!.power === 0);
  });
  const caption = (cut.direction === "u" ? "u cut at k_v = " : "v cut at k_u = ") +
    formatScientific(cut.fixedValue) + " " + waveVectorUnit;
  const chartLabel = caption + "; " + cut.points.length + " plotted points from " +
    cut.sampleCount + " samples; x-axis " + cut.axisName + " (" + waveVectorUnit +
    "); y-axis squared field magnitude (" + powerUnit + "); " + scale + " scale";
  return <figure className="fm-antenna-spectrum__cut" aria-labelledby={captionId}>
    <figcaption id={captionId} className="fm-antenna-spectrum__cut-caption">
      {caption} · {cut.points.length} plotted points from {cut.sampleCount} samples
    </figcaption>
    <svg className="fm-antenna-spectrum__cut-chart" viewBox="0 0 360 152" role="img" aria-label={chartLabel}>
      <line className="fm-antenna-spectrum__cut-gridline" x1={plot.left} x2={plot.right} y1={plot.top} y2={plot.top} />
      <line className="fm-antenna-spectrum__cut-gridline" x1={plot.left} x2={plot.right} y1={plot.bottom} y2={plot.bottom} />
      <path className="fm-antenna-spectrum__cut-line" d={path} />
      {markerPoints.map((point) => <circle key={point.index}
        className={point.index === cut.selectedIndex
          ? "fm-antenna-spectrum__cut-selected"
          : "fm-antenna-spectrum__cut-point"}
        cx={xFor(point.waveVector)} cy={yFor(point.power)}
        r={point.index === cut.selectedIndex ? "3" : "2"} aria-hidden="true" />)}
      <text className="fm-antenna-spectrum__cut-axis-label" x={plot.left - 4} y={plot.top + 4} textAnchor="end">
        {formatScientific(powerMaximum)}
      </text>
      <text className="fm-antenna-spectrum__cut-axis-label" x={plot.left - 4} y={plot.bottom + 4} textAnchor="end">
        {formatScientific(displayMinimum)}
      </text>
      <text className="fm-antenna-spectrum__cut-axis-label" x={plot.left} y="130">
        {formatScientific(minimumX)}
      </text>
      <text className="fm-antenna-spectrum__cut-axis-label" x={plot.right} y="130" textAnchor="end">
        {formatScientific(maximumX)}
      </text>
      <text className="fm-antenna-spectrum__cut-axis-label" x="201" y="146" textAnchor="middle">
        {cut.axisName} ({waveVectorUnit})
      </text>
      <text className="fm-antenna-spectrum__cut-axis-label" x="12" y="62" textAnchor="middle"
        transform="rotate(-90 12 62)">
        |H̃|² ({powerUnit})
      </text>
    </svg>
    {scale === "log" && cut.zeroCount > 0
      ? <p className="fm-antenna-spectrum__cut-status">
        {cut.zeroCount} zero-value samples are omitted, leaving gaps in the logarithmic cut.
      </p>
      : null}
  </figure>;
}

function spectrumCutPath(
  points: readonly SpectrumCutPoint[],
  xFor: (value: number) => number,
  yFor: (value: number) => number,
  scale: SpectrumPowerScale,
): string {
  const commands: string[] = [];
  let segmentOpen = false;
  for (const point of points) {
    if (scale === "log" && point.power <= 0) {
      segmentOpen = false;
      continue;
    }
    commands.push((segmentOpen ? "L" : "M") +
      xFor(point.waveVector).toFixed(2) + "," + yFor(point.power).toFixed(2));
    segmentOpen = true;
  }
  return commands.join(" ");
}

function spectrumGridTransform(
  zoomLevel: number,
  selectedIndex: number,
  columns: number,
  rows: number,
): string | undefined {
  if (zoomLevel === 1 || columns === 0 || rows === 0) return undefined;
  const selectedColumn = selectedIndex % columns;
  const selectedRow = Math.floor(selectedIndex / columns);
  const translateX = Math.max(1 - zoomLevel,
    Math.min(0, 0.5 - (selectedColumn + 0.5) / columns * zoomLevel));
  const translateY = Math.max(1 - zoomLevel,
    Math.min(0, 0.5 - (selectedRow + 0.5) / rows * zoomLevel));
  return "translate(" + (translateX * 100).toFixed(3) + "%, " +
    (translateY * 100).toFixed(3) + "%) scale(" + zoomLevel + ")";
}

function decodePayloads(
  kU: SpectrumPayloadResource,
  kV: SpectrumPayloadResource,
  amplitudes: SpectrumPayloadResource,
  power: SpectrumPayloadResource,
):
  | { kind: "pending" }
  | { kind: "error"; error: Error }
  | { kind: "ready"; value: DecodedPayloads } {
  const resources = [kU, kV, amplitudes, power];
  const error = resources.find((resource) => resource.status === "error" || resource.error || resource.refreshError);
  if (error) {
    return { kind: "error", error: error.error ?? error.refreshError ?? new Error("binary request failed") };
  }
  if (resources.some((resource) => resource.status === "idle" || resource.status === "loading" || resource.status === "stale")) {
    return { kind: "pending" };
  }
  if (resources.some((resource) => !resource.data)) {
    return { kind: "error", error: new Error("binary payload is not published") };
  }
  const results = resources.map((resource) => resource.data);
  if (results.some((result) => !result || result.status !== "ready")) {
    return { kind: "error", error: new Error("binary payload returned without data") };
  }
  try {
    return {
      kind: "ready",
      value: {
        amplitudes: decodeF64LE(binaryData(results[2] ?? null)),
        kU: decodeF64LE(binaryData(results[0] ?? null)),
        kV: decodeF64LE(binaryData(results[1] ?? null)),
        power: decodeF64LE(binaryData(results[3] ?? null)),
      },
    };
  } catch (error) {
    return {
      kind: "error",
      error: error instanceof Error ? error : new Error("binary payload decoding failed"),
    };
  }
}

function formatPayloadError(error: Error): string {
  if (error instanceof ControlRoomApiError) {
    if (error.code === "missing_payload") {
      return "published spectrum manifest references a missing binary payload";
    }
    if (error.code === "unsupported_topology") {
      return "spectrum payload is unsupported for the resolved topology";
    }
  }
  return error.message;
}

function binaryData(result: BinaryResourceResult<ArrayBuffer> | null): ArrayBuffer {
  if (!result || result.status !== "ready") {
    throw new Error("binary payload returned without data");
  }
  return result.data;
}

function decodeF64LE(buffer: ArrayBuffer | undefined): number[] {
  if (!buffer || buffer.byteLength % 8 !== 0) {
    throw new Error("float64_le payload has a non-integral value count");
  }
  const view = new DataView(buffer);
  const values = new Array<number>(buffer.byteLength / 8);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = view.getFloat64(index * 8, true);
  }
  return values;
}

function sameAxis(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

function validatePayloads(
  payloads: DecodedPayloads,
  spectrum: AntennaSourceSpectrumResource,
  expectedKGrid?: AntennaSpectrumKGrid,
): string | null {
  if (expectedKGrid && (!sameAxis(payloads.kU, expectedKGrid.k_u_rad_per_m) || !sameAxis(payloads.kV, expectedKGrid.k_v_rad_per_m))) {
    return "nonuniform k-grid payload differs from the authored axes";
  }
  if (payloads.kU.length !== spectrum.k_u_count) {
    return `k_u count ${payloads.kU.length} ≠ manifest ${spectrum.k_u_count}`;
  }
  if (payloads.kV.length !== spectrum.k_v_count) {
    return `k_v count ${payloads.kV.length} ≠ manifest ${spectrum.k_v_count}`;
  }
  if (payloads.power.length !== spectrum.power_count) {
    return `power count ${payloads.power.length} ≠ manifest ${spectrum.power_count}`;
  }
  if (payloads.amplitudes.length !== spectrum.amplitude_count * 2) {
    return `amplitude scalar count ${payloads.amplitudes.length} ≠ manifest ${spectrum.amplitude_count * 2}`;
  }
  if (payloads.power.length !== payloads.kU.length * payloads.kV.length) {
    return "power payload does not match the declared k-grid";
  }
  if (payloads.amplitudes.length !==
      2 * spectrum.component_labels.length * payloads.power.length) {
    return "complex amplitudes do not match the component and k-grid counts";
  }
  if (payloads.kU.some((value) => !Number.isFinite(value)) ||
      payloads.kV.some((value) => !Number.isFinite(value))) {
    return "wave-vector payload contains a non-finite value";
  }
  if (payloads.amplitudes.some((value) => !Number.isFinite(value))) {
    return "amplitude payload contains a non-finite value";
  }
  if (payloads.power.some((value) => !Number.isFinite(value) || value < 0)) {
    return "power payload contains a non-finite or negative value";
  }
  for (let cell = 0; cell < payloads.power.length; cell += 1) {
    let expectedPower = 0;
    for (let component = 0; component < spectrum.component_labels.length; component += 1) {
      const offset = 2 * (component * payloads.power.length + cell);
      const re = payloads.amplitudes[offset];
      const im = payloads.amplitudes[offset + 1];
      expectedPower += re * re + im * im;
    }
    const actualPower = payloads.power[cell];
    if (!Number.isFinite(expectedPower) ||
        Math.abs(expectedPower - actualPower) >
          1e-10 * Math.max(expectedPower, actualPower, 1e-300)) {
      return `power payload disagrees with complex amplitudes at k-grid cell ${cell}`;
    }
  }
  return null;
}

function heatmapCells(kU: readonly number[], kV: readonly number[], power: readonly number[]): HeatmapCell[] {
  const uBins = Math.min(MAX_AXIS_CELLS, kU.length);
  const vBins = Math.min(MAX_AXIS_CELLS, kV.length);
  const cells: HeatmapCell[] = [];
  for (let vBin = 0; vBin < vBins; vBin += 1) {
    const vStart = Math.floor(vBin * kV.length / vBins);
    const vEnd = Math.floor((vBin + 1) * kV.length / vBins);
    for (let uBin = 0; uBin < uBins; uBin += 1) {
      const uStart = Math.floor(uBin * kU.length / uBins);
      const uEnd = Math.floor((uBin + 1) * kU.length / uBins);
      let selectedU = uStart;
      let selectedV = vStart;
      let selectedPower = Number.NEGATIVE_INFINITY;
      for (let v = vStart; v < vEnd; v += 1) {
        for (let u = uStart; u < uEnd; u += 1) {
          const value = power[v * kU.length + u] ?? Number.NaN;
          if (Number.isFinite(value) && value > selectedPower) {
            selectedPower = value;
            selectedU = u;
            selectedV = v;
          }
        }
      }
      cells.push({
        kUIndex: selectedU,
        kVIndex: selectedV,
        power: selectedPower,
      });
    }
  }
  return cells;
}

function formatScientific(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toExponential(3) : "—";
}
