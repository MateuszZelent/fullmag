/**
 * Import of external dispersion references (COMSOL exports, CSV/TSV) for
 * comparison overlays (ADR 0054, spec 32 §9). Parsing and unit conversion
 * only: no physics is computed here. Units are mapped explicitly by the user.
 */

export type ReferenceAxisUnit = "rad/m" | "rad/um";
export type ReferenceFrequencyUnit = "Hz" | "MHz" | "GHz";

/** Hard bounds for imported reference tables and their persisted SI points. */
export const MAX_REFERENCE_FILE_BYTES = 4 * 1024 * 1024;
/** Match the file byte ceiling for direct parser callers that supply text. */
export const MAX_REFERENCE_TEXT_CHARACTERS = 4 * 1024 * 1024;
/** Bounds per-row parsing work while leaving room for wide multi-quantity exports. */
export const MAX_REFERENCE_COLUMNS = 64;
/** 10,000 finite pairs stay below roughly 1 MiB of JSON numeric payload. */
export const MAX_REFERENCE_DATA_ROWS = 10_000;
export const MAX_REFERENCE_POINTS = MAX_REFERENCE_DATA_ROWS;
/** Allows the data ceiling plus a header and up to one extra blank/comment line per data row. */
export const MAX_REFERENCE_PHYSICAL_LINES = 20_001;

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

export function isReferenceAxisUnit(value: unknown): value is ReferenceAxisUnit {
  return value === "rad/m" || value === "rad/um";
}

export function isReferenceFrequencyUnit(value: unknown): value is ReferenceFrequencyUnit {
  return value === "Hz" || value === "MHz" || value === "GHz";
}

/** Returns a user-facing reason when persisted or submitted SI pairs are unsafe. */
export function referencePointPairsValidationError(value: unknown): string | null {
  if (!Array.isArray(value)) return "Reference points must be an array of numeric pairs.";
  if (value.length < 2) return "The reference needs at least two numeric rows.";
  if (value.length > MAX_REFERENCE_POINTS) {
    return `A reference may contain at most ${MAX_REFERENCE_POINTS.toLocaleString("en-US")} points.`;
  }
  for (const point of value) {
    if (!Array.isArray(point) || point.length !== 2) {
      return "Every reference point must contain one path coordinate and one frequency.";
    }
    if (
      typeof point[0] !== "number" || !Number.isFinite(point[0]) ||
      typeof point[1] !== "number" || !Number.isFinite(point[1])
    ) {
      return "Reference points must contain only finite SI values.";
    }
  }
  return null;
}

export function isReferencePointPairs(value: unknown): value is readonly ReferencePointSi[] {
  return referencePointPairsValidationError(value) === null;
}

type ReferenceDelimiter = "\t" | ";" | ",";

interface ReferenceInputRecord {
  text: string;
  commentHeader: string | null;
}

function delimiterCountOutsideQuotes(line: string, delimiter: ReferenceDelimiter): number {
  let count = 0;
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && character === delimiter) {
      count += 1;
    }
  }
  return count;
}

function detectDelimitedSeparator(
  records: readonly string[],
): ReferenceDelimiter | undefined {
  for (const delimiter of ["\t", ";", ","] as const) {
    if (records.some((record) => delimiterCountOutsideQuotes(record, delimiter) > 0)) {
      return delimiter;
    }
  }
  return undefined;
}

function parseDelimitedLine(line: string, delimiter: ReferenceDelimiter): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let closedQuote = false;

  const pushCell = (): void => {
    if (cells.length >= MAX_REFERENCE_COLUMNS) {
      throw new RangeError(
        "Reference tables may contain at most " + MAX_REFERENCE_COLUMNS + " columns.",
      );
    }
    cells.push(cell.trim());
    cell = "";
    closedQuote = false;
  };

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (inQuotes) {
      if (character === "\"") {
        if (line[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (closedQuote) {
      if (character === delimiter) {
        pushCell();
      } else if (!/\s/.test(character)) {
        throw new SyntaxError("Reference tables contain a malformed quoted CSV field.");
      }
      continue;
    }

    if (character === delimiter) {
      pushCell();
    } else if (character === "\"") {
      if (cell.trim().length > 0) {
        throw new SyntaxError("Reference tables contain a malformed quoted CSV field.");
      }
      cell = "";
      inQuotes = true;
    } else {
      cell += character;
    }
  }

  if (inQuotes) {
    throw new SyntaxError("Reference tables contain an unterminated quoted CSV field.");
  }
  if (cells.length >= MAX_REFERENCE_COLUMNS) {
    throw new RangeError(
      "Reference tables may contain at most " + MAX_REFERENCE_COLUMNS + " columns.",
    );
  }
  cells.push(cell.trim());
  return cells;
}

function splitLine(
  line: string,
  header = false,
  selectedDelimiter?: ReferenceDelimiter,
): string[] {
  const delimiter = selectedDelimiter ?? detectDelimitedSeparator([line]);
  if (delimiter) return parseDelimitedLine(line, delimiter);

  return parseWhitespaceLine(line, header);
}

function parseWhitespaceLine(line: string, header: boolean): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let closedQuote = false;
  const minimumSeparatorLength = header ? 2 : 1;

  const pushCell = (): void => {
    if (cells.length >= MAX_REFERENCE_COLUMNS) {
      throw new RangeError(
        "Reference tables may contain at most " + MAX_REFERENCE_COLUMNS + " columns.",
      );
    }
    cells.push(cell.trim());
    cell = "";
    closedQuote = false;
  };

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (inQuotes) {
      if (character === "\"") {
        if (line[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (/\s/.test(character)) {
      let end = index + 1;
      while (end < line.length && /\s/.test(line[end]!)) end += 1;
      const whitespaceRun = line.slice(index, end);
      if (whitespaceRun.length >= minimumSeparatorLength) {
        pushCell();
      } else if (!closedQuote) {
        cell += whitespaceRun;
      }
      index = end - 1;
      continue;
    }

    if (closedQuote) {
      throw new SyntaxError("Reference tables contain a malformed quoted CSV field.");
    }
    if (character === "\"") {
      if (cell.trim().length > 0) {
        throw new SyntaxError("Reference tables contain a malformed quoted CSV field.");
      }
      cell = "";
      inQuotes = true;
    } else {
      cell += character;
    }
  }

  if (inQuotes) {
    throw new SyntaxError("Reference tables contain an unterminated quoted CSV field.");
  }
  if (cells.length >= MAX_REFERENCE_COLUMNS) {
    throw new RangeError(
      "Reference tables may contain at most " + MAX_REFERENCE_COLUMNS + " columns.",
    );
  }
  cells.push(cell.trim());
  return cells;
}

function quoteStateAfterLine(line: string, inQuotes: boolean): boolean {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== "\"") continue;
    if (inQuotes && line[index + 1] === "\"") {
      index += 1;
    } else {
      inQuotes = !inQuotes;
    }
  }
  return inQuotes;
}

function splitReferenceRecords(text: string): ReferenceInputRecord[] {
  const records: ReferenceInputRecord[] = [];
  let commentHeader: string | null = null;
  let record = "";
  let inQuotes = false;
  let physicalLineCount = 0;
  let lineStart = 0;

  while (lineStart < text.length) {
    physicalLineCount += 1;
    if (physicalLineCount > MAX_REFERENCE_PHYSICAL_LINES) {
      throw new RangeError(
        "Reference tables may contain at most " +
          MAX_REFERENCE_PHYSICAL_LINES.toLocaleString("en-US") +
          " physical lines.",
      );
    }
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const rawLine = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    lineStart = newline < 0 ? text.length : newline + 1;

    const trimmedLine = rawLine.trim();
    if (!inQuotes && record.length === 0) {
      if (!trimmedLine) continue;
      if (trimmedLine.startsWith("%") || trimmedLine.startsWith("#")) {
        commentHeader = trimmedLine.replace(/^[%#]\s*/, "");
        continue;
      }
    }

    if (record.length > 0) record += "\n";
    record += rawLine;
    inQuotes = quoteStateAfterLine(rawLine, inQuotes);
    if (!inQuotes) {
      if (record.trim()) records.push({ text: record, commentHeader });
      record = "";
    }
  }

  if (inQuotes) {
    throw new SyntaxError("Reference tables contain an unterminated quoted CSV field.");
  }
  if (record.trim()) records.push({ text: record, commentHeader });
  return records;
}

/**
 * Reads CSV, TSV or whitespace tables. COMSOL percent/hash comment lines are
 * skipped; the last comment line before the data provides column names when
 * the file has no plain header row.
 */
export function parseReferenceTable(text: string): ReferenceTable {
  if (typeof text !== "string") throw new TypeError("Reference table content must be text.");
  if (text.length > MAX_REFERENCE_TEXT_CHARACTERS) {
    throw new RangeError(
      "Reference table text may not exceed " +
        MAX_REFERENCE_TEXT_CHARACTERS.toLocaleString("en-US") +
        " characters.",
    );
  }

  const records = splitReferenceRecords(text);
  const selectedDelimiter = detectDelimitedSeparator(records.map((record) => record.text));
  let columns: string[] = [];
  const rows: number[][] = [];
  let skippedRowCount = 0;
  let nonCommentRecordCount = 0;

  for (const record of records) {
    nonCommentRecordCount += 1;
    if (nonCommentRecordCount > MAX_REFERENCE_DATA_ROWS + 1) {
      throw new RangeError(
        "Reference tables may contain one header and at most " +
          MAX_REFERENCE_DATA_ROWS.toLocaleString("en-US") +
          " data rows.",
      );
    }

    const line = record.text.trim();
    let commentColumns: string[] = [];
    if (record.commentHeader !== null) {
      try {
        commentColumns = splitLine(record.commentHeader, true);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    const cells = splitLine(line, false, selectedDelimiter);
    const hasEmptyCell = cells.some((cell) => cell.trim().length === 0);
    const values: number[] = hasEmptyCell ? [] : cells.map((cell) => Number(cell));
    if (!hasEmptyCell && values.every((value) => Number.isFinite(value))) {
      if (columns.length === 0) {
        columns = commentColumns.length === values.length
          ? commentColumns
          : values.map((_, index) => "Column " + (index + 1));
      }
      if (values.length === columns.length) {
        if (rows.length >= MAX_REFERENCE_DATA_ROWS) {
          throw new RangeError(
            "Reference tables may contain at most " +
              MAX_REFERENCE_DATA_ROWS.toLocaleString("en-US") +
              " numeric data rows.",
          );
        }
        rows.push(values);
      } else skippedRowCount += 1;
    } else if (rows.length === 0 && columns.length === 0) {
      columns = splitLine(line, true, selectedDelimiter);
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
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
    return { ok: false, reason: "The reference table is malformed." };
  }
  const width = table.columns.length;
  if (width === 0 || width > MAX_REFERENCE_COLUMNS) {
    return { ok: false, reason: `The table must contain between 1 and ${MAX_REFERENCE_COLUMNS} columns.` };
  }
  for (const column of table.columns) {
    if (typeof column !== "string") {
      return { ok: false, reason: "The reference table has invalid column names." };
    }
  }
  if (table.rows.length > MAX_REFERENCE_DATA_ROWS) {
    return {
      ok: false,
      reason: `The reference may contain at most ${MAX_REFERENCE_POINTS.toLocaleString("en-US")} points.`,
    };
  }
  if (
    !mapping || typeof mapping !== "object" ||
    !Number.isSafeInteger(mapping.pathColumn) || !Number.isSafeInteger(mapping.frequencyColumn)
  ) {
    return { ok: false, reason: "Choose valid table columns for the path coordinate and frequency." };
  }
  if (!isReferenceAxisUnit(mapping.pathUnit) || !isReferenceFrequencyUnit(mapping.frequencyUnit)) {
    return { ok: false, reason: "Choose supported units for the path coordinate and frequency." };
  }
  if (mapping.pathColumn === mapping.frequencyColumn) {
    return { ok: false, reason: "Choose different columns for the path coordinate and the frequency." };
  }
  if (
    mapping.pathColumn < 0 || mapping.pathColumn >= width ||
    mapping.frequencyColumn < 0 || mapping.frequencyColumn >= width
  ) {
    return { ok: false, reason: "The selected columns do not exist in the file." };
  }
  const points: ReferencePointSi[] = [];
  for (const row of table.rows) {
    if (!Array.isArray(row) || row.length !== width) {
      return { ok: false, reason: "The reference table contains a malformed or non-finite numeric row." };
    }
    for (const value of row) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: "The reference table contains a malformed or non-finite numeric row." };
      }
    }
    const path = row[mapping.pathColumn]! * PATH_SCALE[mapping.pathUnit];
    const frequency = row[mapping.frequencyColumn]! * FREQUENCY_SCALE[mapping.frequencyUnit];
    if (!Number.isFinite(path) || !Number.isFinite(frequency)) {
      return { ok: false, reason: "Unit conversion produced a non-finite SI value." };
    }
    points.push([path, frequency]);
  }
  if (points.length < 2) {
    return { ok: false, reason: "The reference needs at least two numeric rows." };
  }
  return { ok: true, points: points.toSorted((left, right) => left[0] - right[0]) };
}
