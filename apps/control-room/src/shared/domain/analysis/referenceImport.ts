/**
 * Import of external dispersion references (COMSOL exports, CSV/TSV) for
 * comparison overlays (ADR 0054, spec 32 §9). Parsing and unit conversion
 * only: no physics is computed here. Units are mapped explicitly by the user.
 */

export type ReferenceAxisUnit = "rad/m" | "rad/um";
export type ReferenceFrequencyUnit = "Hz" | "MHz" | "GHz";

export interface ReferenceTable {
  columns: string[];
  rows: number[][];
  skippedRowCount: number;
}

export interface ReferenceColumnMapping {
  frequencyColumn: number;
  frequencyUnit: ReferenceFrequencyUnit;
  pathColumn: number;
  pathUnit: ReferenceAxisUnit;
}

/** Points in SI: path coordinate [rad/m] and frequency [Hz]. */
export type ReferencePointSi = readonly [number, number];

const PATH_SCALE: Record<ReferenceAxisUnit, number> = { "rad/m": 1, "rad/um": 1e6 };
const FREQUENCY_SCALE: Record<ReferenceFrequencyUnit, number> = { GHz: 1e9, Hz: 1, MHz: 1e6 };

function splitLine(line: string, header = false): string[] {
  // Header names may contain single spaces ("k (rad/um)"); COMSOL separates
  // header columns with runs of spaces, data columns with any whitespace.
  const delimiter = line.includes("\t")
    ? "\t"
    : line.includes(";")
      ? ";"
      : line.includes(",")
        ? ","
        : header
          ? /\s{2,}/
          : /\s+/;
  return line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ""));
}

/**
 * Reads CSV, TSV or whitespace tables. COMSOL `%` and `#` comment lines are
 * skipped; the last comment line before the data provides column names when
 * the file has no plain header row.
 */
export function parseReferenceTable(text: string): ReferenceTable {
  let columns: string[] = [];
  let lastComment: string[] = [];
  const rows: number[][] = [];
  let skippedRowCount = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("%") || line.startsWith("#")) {
      lastComment = splitLine(line.replace(/^[%#]\s*/, ""), true);
      continue;
    }
    const cells = splitLine(line);
    const values = cells.map((cell) => Number(cell));
    if (values.every((value) => Number.isFinite(value))) {
      if (columns.length === 0) {
        columns = lastComment.length === values.length
          ? lastComment
          : values.map((_, index) => `Column ${index + 1}`);
      }
      if (values.length === columns.length) rows.push(values);
      else skippedRowCount += 1;
    } else if (rows.length === 0 && columns.length === 0) {
      columns = splitLine(line, true);
    } else {
      skippedRowCount += 1;
    }
  }
  return { columns, rows, skippedRowCount };
}

export type ReferencePointsResult =
  | { ok: true; points: ReferencePointSi[] }
  | { ok: false; reason: string };

export function referencePointsFromTable(
  table: ReferenceTable,
  mapping: ReferenceColumnMapping,
): ReferencePointsResult {
  const width = table.columns.length;
  if (mapping.pathColumn === mapping.frequencyColumn) {
    return { ok: false, reason: "Choose different columns for the path coordinate and the frequency." };
  }
  if (
    mapping.pathColumn < 0 || mapping.pathColumn >= width ||
    mapping.frequencyColumn < 0 || mapping.frequencyColumn >= width
  ) {
    return { ok: false, reason: "The selected columns do not exist in the file." };
  }
  const points = table.rows
    .map((row): ReferencePointSi => [
      row[mapping.pathColumn]! * PATH_SCALE[mapping.pathUnit],
      row[mapping.frequencyColumn]! * FREQUENCY_SCALE[mapping.frequencyUnit],
    ])
    .filter(([path, frequency]) => Number.isFinite(path) && Number.isFinite(frequency));
  if (points.length < 2) {
    return { ok: false, reason: "The reference needs at least two numeric rows." };
  }
  return { ok: true, points: points.toSorted((left, right) => left[0] - right[0]) };
}
