import type { ChartPoint, ChartSeries } from "@/shared/domain/analysis/chartSeries";
import { parseReferenceTable } from "@/shared/domain/analysis/referenceImport";

export const ABSORBED_POWER_QUANTITY = "absorbed_power";

interface AbsorptionProfile {
  peak: ChartPoint;
  series: ChartSeries;
}

export interface AbsorptionSpectrum {
  fileName: string;
  profiles: readonly AbsorptionProfile[];
  sampleCount: number;
  powerDisplayUnit: string;
}

const POWER_UNITS = [
  ["kW", 1e3],
  ["W", 1],
  ["mW", 1e-3],
  ["µW", 1e-6],
  ["nW", 1e-9],
  ["pW", 1e-12],
  ["fW", 1e-15],
  ["aW", 1e-18],
] as const;

export function parseAbsorptionSpectrum(text: string, fileName: string): AbsorptionSpectrum {
  const { columns, rows, skippedRowCount } = parseReferenceTable(text);
  const frequencyColumn = columns.indexOf("frequency_Hz");
  if (frequencyColumn === -1) {
    throw new Error("Include a frequency_Hz column with frequency in hertz.");
  }
  if (new Set(columns).size !== columns.length) {
    throw new Error("Use unique column names.");
  }
  const powerColumns = columns
    .map((name, index) => ({ name, index }))
    .filter(({ name }) => name.endsWith("_W") && /\S/.test(name.slice(0, -2)));
  if (powerColumns.length === 0) {
    throw new Error("Include at least one absorbed power column ending in _W.");
  }
  if (skippedRowCount > 0) {
    throw new Error("Every sample row must contain a finite value for each column.");
  }
  if (rows.length < 2) {
    throw new Error("Include at least two frequency samples.");
  }

  let previousFrequency = -Infinity;
  const frequencies = rows.map((row) => {
    const frequency = row[frequencyColumn]!;
    if (frequency < 0 || frequency <= previousFrequency) {
      throw new Error("Frequencies must be non-negative and strictly increasing.");
    }
    previousFrequency = frequency;
    return frequency;
  });

  let maximumMagnitude = 0;
  const profiles = powerColumns.map(({ name, index }): AbsorptionProfile => {
    const points = rows.map((row, rowIndex): ChartPoint => ({
      rowIndex,
      x: frequencies[rowIndex]!,
      y: row[index]!,
    }));
    let peak = points[0]!;
    for (const point of points) {
      if (point.y > peak.y) peak = point;
      maximumMagnitude = Math.max(maximumMagnitude, Math.abs(point.y));
    }

    const label = name.slice(0, -2).replaceAll("_", " ").trim();
    return {
      peak,
      series: {
        id: name,
        kind: "line",
        label: label.charAt(0).toUpperCase() + label.slice(1),
        points,
        quantity: ABSORBED_POWER_QUANTITY,
        selectable: false,
        source: {
          kind: "analysis.frequency_domain",
          resourceKey: `local-csv:${fileName}`,
          tableId: "rf-absorption",
        },
        status: "ready",
        unit: "W",
        xUnit: "Hz",
      },
    };
  });

  const powerDisplayUnit = POWER_UNITS.find(([, factor]) => maximumMagnitude >= factor * 0.5)?.[0];
  return { fileName, profiles, powerDisplayUnit: powerDisplayUnit ?? "W", sampleCount: rows.length };
}
