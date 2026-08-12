import { describe, expect, it } from "vitest";

import {
  definePostprocessing,
  postprocessingDefinitionFromArtifact,
  postprocessingDefinitionFromTable,
  type PostprocessingDefinition,
} from "./postprocessingDefinitions";

describe("postprocessing definitions", () => {
  it("references a dataset identity without copying its payload", () => {
    expect(definePostprocessing({
      datasetRef: "table:energy",
      id: "view-energy",
      kind: "analysis_view",
      label: "Energy view",
    })).toEqual({
      availability: "unavailable",
      contractGap: "No persistent owner resource is published for user-defined postprocessing definitions.",
      datasetRef: "table:energy",
      id: "view-energy",
      kind: "analysis_view",
      label: "Energy view",
      owner: null,
    });
  });

  it("keeps definitions with an empty dataset identity unavailable", () => {
    expect(definePostprocessing({
      datasetRef: "",
      id: "view-energy",
      kind: "analysis_view",
      label: "Energy view",
    })).toMatchObject({
      availability: "unavailable",
      contractGap: expect.stringMatching(/persistent owner/),
      datasetRef: "",
      owner: null,
    });
  });

  it.each([
    "analysis_view",
    "derived_value",
  ] as const)("keeps %s unavailable without a persistent owner", (kind) => {
    expect(definePostprocessing({
      datasetRef: "table:energy",
      id: `${kind}:energy`,
      kind,
      label: "Energy",
    })).toMatchObject({
      availability: "unavailable",
      contractGap: expect.stringMatching(/persistent owner/),
      datasetRef: "table:energy",
      owner: null,
    });
  });

  it("fails closed for an incomplete existing owner", () => {
    expect(definePostprocessing({
      datasetRef: "table:energy",
      id: "table:energy",
      kind: "table",
      label: "Energy",
      owner: {
        kind: "table",
        resourceRef: "table:energy",
        revision: 7,
        schemaRevision: 2,
        tableId: "",
      },
    })).toMatchObject({
      availability: "unavailable",
      contractGap: expect.stringMatching(/persistent owner/),
      owner: null,
    });
  });

  it("projects only TableResource identity and revision, never table payload", () => {
    const table = {
      binary_rows_href: "/tables/energy/rows.bin",
      columns: [{
        column_id: "t",
        dimension: "time",
        label: "Time",
        quantity_id: "time",
        scope: "global",
        unit: "s",
        value_type: "float64",
      }],
      columns_href: "/tables/energy/columns",
      revision: 7,
      rows_href: "/tables/energy/rows",
      schema_revision: 2,
      table_id: "energy",
      total_rows: 12,
    };

    const definition = postprocessingDefinitionFromTable(table);

    expect(definition).toMatchObject({
      datasetRef: "table:energy",
      id: "table:energy",
      kind: "table",
      owner: {
        kind: "table",
        resourceRef: "table:energy",
        revision: 7,
        schemaRevision: 2,
        tableId: "energy",
      },
      resourceRevision: 7,
    });
    expect(definition).not.toHaveProperty("columns");
    expect(definition).not.toHaveProperty("total_rows");
    expect(definition).not.toHaveProperty("rows_href");
  });

  it("projects artifact identity without copying the artifact payload", () => {
    const artifact = { kind: "csv", path: "runs/run-7/table.csv" };
    const definition = postprocessingDefinitionFromArtifact(artifact);

    expect(definition).toMatchObject({
      datasetRef: "artifact:runs/run-7/table.csv",
      id: "artifact:runs/run-7/table.csv",
      kind: "export",
      owner: {
        artifactKind: "csv",
        kind: "artifact",
        path: "runs/run-7/table.csv",
        resourceRef: "artifact:runs/run-7/table.csv",
      },
    });
    expect(definition).not.toHaveProperty("kind", "csv");
    expect(definition).not.toHaveProperty("path");
  });

  it("keeps malformed catalog entries as explicit unavailable definitions", () => {
    expect(postprocessingDefinitionFromTable({
      binary_rows_href: "/rows.bin",
      columns: [],
      columns_href: "/columns",
      revision: 7,
      rows_href: "/rows",
      schema_revision: 2,
      table_id: "",
      total_rows: 12,
    })).toMatchObject({
      availability: "unavailable",
      owner: null,
    });

    expect(postprocessingDefinitionFromArtifact({ kind: "csv", path: "" })).toMatchObject({
      availability: "unavailable",
      owner: null,
    });
  });

  it("does not accept user-defined payload fields as a definition contract", () => {
    const definition: PostprocessingDefinition = {
      availability: "available",
      contractGap: null,
      datasetRef: "table:energy",
      id: "table:energy",
      kind: "table",
      label: "Energy",
      owner: {
        kind: "table",
        resourceRef: "table:energy",
        revision: 7,
        schemaRevision: 2,
        tableId: "energy",
      },
      resourceRevision: 7,
    };

    expect(Object.keys(definition).sort()).toEqual([
      "availability",
      "contractGap",
      "datasetRef",
      "id",
      "kind",
      "label",
      "owner",
      "resourceRevision",
    ]);
  });
});
