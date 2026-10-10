import { describe, expect, it } from "vitest";

import {
  MAX_REFERENCE_COLUMNS,
  MAX_REFERENCE_DATA_ROWS,
  MAX_REFERENCE_PHYSICAL_LINES,
  MAX_REFERENCE_POINTS,
  MAX_REFERENCE_TEXT_CHARACTERS,
  parseReferenceTable,
  referencePointPairsValidationError,
  referencePointsFromTable,
} from "./referenceImport";

const comsolExport = `% Model: film.mph
% Description: Eigenfrequency (GHz)
% k (rad/um)  freq (GHz)
-25  13.68
-15  12.10
0    9.32
15   12.10
`;

describe("reference import", () => {
  it("reads COMSOL exports using the last comment line as column names", () => {
    const table = parseReferenceTable(comsolExport);
    expect(table.columns).toEqual(["k (rad/um)", "freq (GHz)"]);
    expect(table.rows).toHaveLength(4);
  });

  it("reads CSV with a header row and skips malformed rows", () => {
    const table = parseReferenceTable("s,f\n1,2\n3,x\n5,6\n");
    expect(table.columns).toEqual(["s", "f"]);
    expect(table.rows).toEqual([[1, 2], [5, 6]]);
    expect(table.skippedRowCount).toBe(1);
  });

  it("skips empty CSV cells without treating explicit zero as missing", () => {
    const table = parseReferenceTable(
      "s,f,g\n1,2,3\n4,,6\n7,8,\n9,   ,11\n12,0,14\n",
    );
    expect(table.columns).toEqual(["s", "f", "g"]);
    expect(table.rows).toEqual([[1, 2, 3], [12, 0, 14]]);
    expect(table.skippedRowCount).toBe(3);
  });

  it("converts the mapped columns to SI and sorts along the path", () => {
    const result = referencePointsFromTable(parseReferenceTable(comsolExport), {
      frequencyColumn: 1,
      frequencyUnit: "GHz",
      pathColumn: 0,
      pathUnit: "rad/um",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.points[0]).toEqual([-25e6, 13.68e9]);
    expect(result.points.at(-1)).toEqual([15e6, 12.1e9]);
  });

  it("rejects ambiguous or too small mappings", () => {
    const table = parseReferenceTable(comsolExport);
    expect(referencePointsFromTable(table, { frequencyColumn: 0, frequencyUnit: "GHz", pathColumn: 0, pathUnit: "rad/um" }).ok).toBe(false);
    expect(referencePointsFromTable(parseReferenceTable("a,b\n1,2\n"), { frequencyColumn: 1, frequencyUnit: "Hz", pathColumn: 0, pathUnit: "rad/m" }).ok).toBe(false);
  });

  it("enforces bounded text, physical-line, record, and column parsing", () => {
    expect(() => parseReferenceTable("x".repeat(MAX_REFERENCE_TEXT_CHARACTERS + 1))).toThrow(/characters/);
    expect(() => parseReferenceTable("\n".repeat(MAX_REFERENCE_PHYSICAL_LINES + 1))).toThrow(/physical lines/);
    expect(() => parseReferenceTable(
      `s,f\n${"1,2\n".repeat(MAX_REFERENCE_DATA_ROWS + 1)}`,
    )).toThrow(/at most/);
    const tooManyColumns = Array.from({ length: MAX_REFERENCE_COLUMNS + 1 }, (_, index) => `c${index}`).join(",");
    expect(() => parseReferenceTable(tooManyColumns)).toThrow(/columns/);
  });

  it("retains every row and column at the exact supported bounds", () => {
    const tableAtRowLimit = parseReferenceTable(`s,f\n${"1,2\n".repeat(MAX_REFERENCE_DATA_ROWS)}`);
    const wideHeader = Array.from({ length: MAX_REFERENCE_COLUMNS }, (_, index) => `c${index}`).join(",");
    const wideRow = Array.from({ length: MAX_REFERENCE_COLUMNS }, () => "1").join(",");
    const tableAtColumnLimit = parseReferenceTable(`${wideHeader}\n${wideRow}\n`);

    expect(tableAtRowLimit.rows).toHaveLength(MAX_REFERENCE_DATA_ROWS);
    expect(tableAtColumnLimit.columns).toHaveLength(MAX_REFERENCE_COLUMNS);
    expect(tableAtColumnLimit.rows).toEqual([Array.from({ length: MAX_REFERENCE_COLUMNS }, () => 1)]);
  });

  it("rejects malformed direct tables and SI conversion overflow without dropping rows", () => {
    const mapping = { frequencyColumn: 1, frequencyUnit: "Hz", pathColumn: 0, pathUnit: "rad/m" } as const;
    expect(referencePointsFromTable({ columns: ["s", "f"], rows: [[1, 2], [Number.NaN, 3]], skippedRowCount: 0 }, mapping))
      .toMatchObject({ ok: false, reason: expect.stringContaining("malformed") });
    expect(referencePointsFromTable({ columns: ["s", "f"], rows: [[Number.MAX_VALUE, 2], [3, 4]], skippedRowCount: 0 }, {
      ...mapping,
      pathUnit: "rad/um",
    })).toMatchObject({ ok: false, reason: expect.stringContaining("non-finite") });
    expect(referencePointsFromTable(parseReferenceTable("s,f\n1,2\n3,4\n"), {
      ...mapping,
      pathColumn: 0.5,
    } as never).ok).toBe(false);
  });

  it("bounds complete saved SI point arrays before any consumer copies them", () => {
    const points = Array.from({ length: MAX_REFERENCE_POINTS }, (_, index) => [index, index] as const);
    expect(referencePointPairsValidationError(points)).toBeNull();
    expect(referencePointPairsValidationError([...points, [MAX_REFERENCE_POINTS, MAX_REFERENCE_POINTS]]))
      .toMatch(/at most/);
    expect(referencePointPairsValidationError([[0, 1], [2, Number.POSITIVE_INFINITY]]))
      .toMatch(/finite/);
    expect(referencePointPairsValidationError([[0, 1], [2, 3, 4]]))
      .toMatch(/one path coordinate/);
  });
});
