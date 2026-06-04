import { describe, expect, it } from "vitest";

import { __analysisPlotsTestUtils } from "./AnalysisPlotsModule";
import { buildLineChartModel, MAX_LINE_CHART_POINTS } from "./analysisPlotModel";

describe("analysisPlotModel", () => {
  it("builds a normalized SVG path from finite points", () => {
    expect(
      buildLineChartModel([
        { x: 0, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 1 },
      ]),
    ).toMatchObject({
      path: "M12.00 128.00 L160.00 12.00 L308.00 128.00",
      xMax: 2,
      xMin: 0,
      yMax: 2,
      yMin: 1,
    });
  });

  it("returns null without finite samples", () => {
    expect(buildLineChartModel([{ x: Number.NaN, y: 1 }])).toBeNull();
  });

  it("decimates large histories while preserving the full value range", () => {
    const points = Array.from({ length: 1_000 }, (_, index) => ({
      x: index,
      y: index === 511 ? 100 : Math.sin(index / 10),
    }));

    const model = buildLineChartModel(points);

    expect(model?.path.match(/[ML]/g)?.length).toBeLessThanOrEqual(
      MAX_LINE_CHART_POINTS,
    );
    expect(model).toMatchObject({
      xMax: 999,
      xMin: 0,
      yMax: 100,
    });
  });
});

describe("analysis plot scalar selection", () => {
  it("uses one stable scalar column query for resource subscriptions", () => {
    expect(__analysisPlotsTestUtils.analysisScalarColumns).toEqual([
      "step",
      "t",
      "mx",
      "my",
      "mz",
      "e_total",
      "max_torque",
    ]);
    expect(Object.isFrozen(__analysisPlotsTestUtils.analysisScalarColumns)).toBe(
      true,
    );
  });

  it("merges cursor deltas into the bounded table window", () => {
    expect(
      __analysisPlotsTestUtils.mergeTableRows(
        {
          columns: [
            {
              column_id: "step",
              component: null,
              dimension: "count",
              label: "step",
              quantity_id: "step",
              reduction: null,
              unit: "1",
              value_type: "integer",
            },
          ],
          cursor_end: 1,
          cursor_start: 1,
          resync_required: false,
          returned_rows: 1,
          revision: 1,
          rows: [[1]],
          schema_revision: 1,
          table_id: "default",
          total_rows: 1,
        },
        {
          columns: [
            {
              column_id: "step",
              component: null,
              dimension: "count",
              label: "step",
              quantity_id: "step",
              reduction: null,
              unit: "1",
              value_type: "integer",
            },
          ],
          cursor_end: 2,
          cursor_start: 2,
          resync_required: false,
          returned_rows: 1,
          revision: 2,
          rows: [[2]],
          schema_revision: 1,
          table_id: "default",
          total_rows: 2,
        },
      ).rows,
    ).toEqual([[1], [2]]);
  });

  it("deduplicates live scalar samples that are already present in a fetched table window", () => {
    const table = {
      columns: [
        {
          column_id: "step",
          component: null,
          dimension: "count",
          label: "step",
          quantity_id: "step",
          reduction: null,
          unit: "1",
          value_type: "integer",
        },
      ],
      cursor_end: 2,
      cursor_start: 1,
      resync_required: false,
      returned_rows: 2,
      revision: 2,
      rows: [[1], [2]],
      schema_revision: 1,
      table_id: "default",
      total_rows: 2,
    };

    expect(
      __analysisPlotsTestUtils.mergeTableRows(table, {
        ...table,
        cursor_start: 2,
        returned_rows: 1,
        rows: [[2]],
      }).rows,
    ).toEqual([[1], [2]]);
  });

  it("adapts live scalar sample websocket payloads into one-row table resources", () => {
    const resource =
      __analysisPlotsTestUtils.tableRowsResourceFromScalarSample({
        columns: [
          {
            column_id: "step",
            component: null,
            dimension: "count",
            label: "step",
            quantity_id: "step",
            reduction: null,
            unit: "1",
            value_type: "integer",
          },
          {
            column_id: "t",
            component: null,
            dimension: "time",
            label: "t",
            quantity_id: "t",
            reduction: null,
            unit: "s",
            value_type: "float",
          },
          {
            column_id: "max_torque",
            component: null,
            dimension: "effective_field",
            label: "max torque",
            quantity_id: "max_torque_Apm",
            reduction: "max",
            unit: "A/m",
            value_type: "float",
          },
        ],
        queryColumns: ["step", "t", "max_torque"],
        sample: {
          revision: 9,
          row: { max_torque_Apm: 0.4, step: 7, time: 0.2 },
        },
        tableId: "default",
      });

    expect(resource?.cursor_end).toBe(9);
    expect(resource?.rows).toEqual([[7, 0.2, 0.4]]);
  });

  it("adapts decoded binary table rows into the chart table resource shape", () => {
    const resource =
      __analysisPlotsTestUtils.tableRowsResourceFromBinary({
        columns: [
          {
            column_id: "step",
            component: null,
            dimension: "count",
            label: "step",
            quantity_id: "step",
            reduction: null,
            unit: "1",
            value_type: "integer",
          },
          {
            column_id: "mx",
            component: "x",
            dimension: "magnetization",
            label: "mx",
            quantity_id: "mx",
            reduction: "mean",
            unit: "1",
            value_type: "float",
          },
        ],
        decoded: {
          columnCount: 2,
          cursorEnd: 2,
          cursorStart: 1,
          resyncRequired: false,
          revision: 2,
          rowCount: 2,
          schemaRevision: 1,
          totalRows: 2,
          values: new Float64Array([1, 0.1, 2, 0.2]),
        },
        queryColumns: ["step", "mx"],
        tableId: "default",
      });

    expect(resource).toMatchObject({
      cursor_end: 2,
      cursor_start: 1,
      returned_rows: 2,
      revision: 2,
      rows: [
        [1, 0.1],
        [2, 0.2],
      ],
    });
  });
});
