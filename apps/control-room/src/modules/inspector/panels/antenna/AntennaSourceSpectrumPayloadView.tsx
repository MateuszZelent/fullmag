"use client";

import { useMemo } from "react";

import type {
  AntennaSourceSpectrumResource,
  BinaryResourceResult,
} from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import { useAntennaSourceSpectrumPayloadResource } from "@/kernel/resources/antennaResources";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";

const MAX_AXIS_CELLS = 64;
const MAX_RENDERED_CELLS = MAX_AXIS_CELLS * MAX_AXIS_CELLS;

interface SpectrumPayloadViewProps {
  outputId: string;
  spectrum: AntennaSourceSpectrumResource;
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
  normalizedPower: number;
  power: number;
}

type SpectrumPayloadResource = ResourceResult<
  BinaryResourceResult<ArrayBuffer> | null
>;

export function AntennaSourceSpectrumPayloadView({
  outputId,
  spectrum,
}: SpectrumPayloadViewProps) {
  const kU = useAntennaSourceSpectrumPayloadResource(outputId, "k_u_rad_per_m");
  const kV = useAntennaSourceSpectrumPayloadResource(outputId, "k_v_rad_per_m");
  const amplitudes = useAntennaSourceSpectrumPayloadResource(
    outputId,
    "amplitudes_re_im",
  );
  const power = useAntennaSourceSpectrumPayloadResource(outputId, "power");
  const payloads = useMemo(
    () => decodePayloads(kU, kV, amplitudes, power),
    [amplitudes, kU, kV, power],
  );

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

  const validation = validatePayloads(payloads.value, spectrum);
  if (validation) {
    return (
      <section className="fm-antenna-spectrum" aria-label="Antenna source spectrum payload">
        <p className="fm-antenna-spectrum__status fm-antenna-spectrum__status--error" role="alert">
          FFT payload integrity error: {validation}
        </p>
      </section>
    );
  }

  const cells = heatmapCells(payloads.value.kU, payloads.value.kV, payloads.value.power);
  const peak = payloads.value.power.reduce<{
    index: number;
    value: number;
  } | null>((current, value, index) => {
    if (!Number.isFinite(value)) return current;
    return current === null || value > current.value ? { index, value } : current;
  }, null);
  const peakKU = peak ? payloads.value.kU[peak.index % payloads.value.kU.length] : null;
  const peakKV = peak
    ? payloads.value.kV[Math.floor(peak.index / payloads.value.kU.length)]
    : null;
  const renderedCellCount = cells.length;
  const isDecimated =
    payloads.value.kU.length * payloads.value.kV.length > MAX_RENDERED_CELLS;
  const powerUnit = spectrum.payloads?.power.unit ?? `(${spectrum.amplitude_unit})^2`;

  return (
    <section className="fm-antenna-spectrum" aria-label="Antenna source spectrum payload">
      <div className="fm-antenna-spectrum__header">
        <div>
          <h3 className="fm-antenna-spectrum__title">Source FFT power</h3>
          <p className="fm-antenna-spectrum__subtitle">
            |H(k<sub>u</sub>, k<sub>v</sub>)|² · per 1 A port-current basis; drive
            waveform not applied
          </p>
        </div>
        <span className="fm-antenna-spectrum__badge" data-status="ready">
          {isDecimated ? "bounded" : "full grid"}
        </span>
      </div>
      <div
        className="fm-antenna-spectrum__heatmap"
        role="grid"
        aria-label={`${renderedCellCount} source-spectrum power cells`}
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, Math.min(MAX_AXIS_CELLS, payloads.value.kU.length))}, minmax(2px, 1fr))`,
        }}
      >
        {cells.map((cell) => (
          <span
            aria-label={`k_u ${formatScientific(payloads.value.kU[cell.kUIndex])} ${spectrum.wave_vector_unit}, k_v ${formatScientific(payloads.value.kV[cell.kVIndex])} ${spectrum.wave_vector_unit}, power ${formatScientific(cell.power)} ${powerUnit}`}
            className="fm-antenna-spectrum__cell"
            key={`${cell.kVIndex}:${cell.kUIndex}`}
            role="gridcell"
            style={{ opacity: 0.08 + 0.92 * cell.normalizedPower }}
            title={`k_u=${formatScientific(payloads.value.kU[cell.kUIndex])} ${spectrum.wave_vector_unit}; k_v=${formatScientific(payloads.value.kV[cell.kVIndex])} ${spectrum.wave_vector_unit}; |H|²=${formatScientific(cell.power)} ${powerUnit}`}
          />
        ))}
      </div>
      <div className="fm-antenna-spectrum__axes" aria-label="Source spectrum axes">
        <span>u: {payloads.value.kU.length} · {spectrum.wave_vector_unit}</span>
        <span>v: {payloads.value.kV.length} · {spectrum.wave_vector_unit}</span>
        <span>cells: {renderedCellCount}{isDecimated ? " (decimated)" : ""}</span>
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
  const error = resources.find((resource) => resource.status === "error");
  if (error?.status === "error") {
    return { kind: "error", error: error.error ?? new Error("binary request failed") };
  }
  if (resources.some((resource) => resource.status === "idle" || resource.status === "loading")) {
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

function validatePayloads(
  payloads: DecodedPayloads,
  spectrum: AntennaSourceSpectrumResource,
): string | null {
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
  return null;
}

function heatmapCells(kU: readonly number[], kV: readonly number[], power: readonly number[]): HeatmapCell[] {
  const uIndices = boundedIndices(kU.length);
  const vIndices = boundedIndices(kV.length);
  const values = vIndices.flatMap((kVIndex) =>
    uIndices.map((kUIndex) => power[kVIndex * kU.length + kUIndex] ?? Number.NaN),
  );
  const finiteValues = values.filter(Number.isFinite);
  const max = finiteValues.length > 0 ? Math.max(...finiteValues) : 0;
  const min = finiteValues.length > 0 ? Math.min(...finiteValues) : 0;
  const range = max > min ? max - min : 1;
  return vIndices.flatMap((kVIndex) =>
    uIndices.map((kUIndex) => {
      const value = power[kVIndex * kU.length + kUIndex] ?? Number.NaN;
      return {
        kUIndex,
        kVIndex,
        normalizedPower: Number.isFinite(value) ? Math.max(0, Math.min(1, (value - min) / range)) : 0,
        power: value,
      };
    }),
  );
}

function boundedIndices(count: number): number[] {
  if (count <= MAX_AXIS_CELLS) return Array.from({ length: count }, (_, index) => index);
  const stride = Math.ceil(count / MAX_AXIS_CELLS);
  const indices: number[] = [];
  for (let index = 0; index < count; index += stride) indices.push(index);
  return indices.slice(0, MAX_AXIS_CELLS);
}

function formatScientific(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toExponential(3) : "—";
}
