import { describe, expect, it } from "vitest";

import { definePostprocessing } from "./postprocessingDefinitions";

describe("postprocessing definitions", () => {
  it("references a dataset identity without copying its payload", () => {
    expect(definePostprocessing({
      datasetRef: "table:energy",
      id: "view-energy",
      kind: "analysis_view",
      label: "Energy view",
      persistentOwner: false,
    })).toEqual({
      datasetRef: "table:energy",
      id: "view-energy",
      kind: "analysis_view",
      label: "Energy view",
      persistentOwner: false,
    });
  });

  it("rejects ownerless definitions", () => {
    expect(() => definePostprocessing({
      datasetRef: "",
      id: "view-energy",
      kind: "analysis_view",
      label: "Energy view",
      persistentOwner: false,
    })).toThrow(/dataset owner/);
  });
});
