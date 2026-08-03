import { describe, expect, it } from "vitest";

import { resolveAnalysisDatasetTableId, shouldLoadAnalysisDatasetRows } from "./useAnalysisDatasetData";

describe("useAnalysisDatasetData", () => {
  it("does not load table rows without a selected dataset", () => {
    expect(shouldLoadAnalysisDatasetRows({ datasetRef: null, enabled: true, hasSchema: true })).toBe(false);
  });

  it("resolves only an explicit identity published by the table list", () => {
    expect(resolveAnalysisDatasetTableId("table:run-7:stage-2:table-4", ["table-4"])).toBe("table-4");
    expect(resolveAnalysisDatasetTableId("artifact:run-7:result", ["table-4"])).toBeNull();
    expect(shouldLoadAnalysisDatasetRows({ datasetRef: "table:run-7:stage-2:table-4", enabled: true, hasSchema: true })).toBe(true);
  });
});
