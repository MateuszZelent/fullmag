import { describe, expect, it } from "vitest";

import { parseReferenceTable, referencePointsFromTable } from "./referenceImport";

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
});
