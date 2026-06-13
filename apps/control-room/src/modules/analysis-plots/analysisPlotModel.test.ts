import { describe, expect, it } from "vitest";

import { __analysisTableRowsAdapterTestUtils } from "./tableRowsAdapter";

describe("analysis plot scalar selection", () => {
  it("uses one stable scalar column query for resource subscriptions", () => {
    expect(__analysisTableRowsAdapterTestUtils.analysisScalarColumns).toEqual([
      "step",
      "t",
      "mx",
      "my",
      "mz",
      "e_total",
      "max_torque",
      "pseudo_time_s",
      "active_runtime_s",
    ]);
    expect(Object.isFrozen(__analysisTableRowsAdapterTestUtils.analysisScalarColumns)).toBe(
      true,
    );
  });

  it("merges cursor deltas into the bounded table window", () => {
    expect(
      __analysisTableRowsAdapterTestUtils.mergeTableRows(
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
      __analysisTableRowsAdapterTestUtils.mergeTableRows(table, {
        ...table,
        cursor_start: 2,
        returned_rows: 1,
        rows: [[2]],
      }).rows,
    ).toEqual([[1], [2]]);
  });

  it("adapts live scalar sample websocket payloads into one-row table resources", () => {
    const resource =
      __analysisTableRowsAdapterTestUtils.tableRowsResourceFromScalarSample({
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
          {
            column_id: "pseudo_time_s",
            component: null,
            dimension: "time",
            label: "pseudo time",
            quantity_id: "pseudo_time_s",
            reduction: null,
            unit: "s",
            value_type: "float",
          },
          {
            column_id: "active_runtime_s",
            component: null,
            dimension: "time",
            label: "active runtime",
            quantity_id: "active_runtime_s",
            reduction: null,
            unit: "s",
            value_type: "float",
          },
        ],
        queryColumns: [
          "step",
          "t",
          "max_torque",
          "pseudo_time_s",
          "active_runtime_s",
        ],
        sample: {
          revision: 9,
          row: {
            active_runtime_s: 0.15,
            max_torque_Apm: 0.4,
            pseudo_time_s: 0.5,
            step: 7,
            time: 0.2,
          },
        },
        tableId: "default",
      });

    expect(resource?.cursor_end).toBe(9);
    expect(resource?.rows).toEqual([[7, 0.2, 0.4, 0.5, 0.15]]);
  });

  it("adapts decoded binary table rows into the chart table resource shape", () => {
    const resource =
      __analysisTableRowsAdapterTestUtils.tableRowsResourceFromBinary({
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

  it("keeps the binary fetch cursor stable when appending websocket samples", () => {
    const current = {
      cursor: 10,
      visibleTable: {
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
        cursor_end: 10,
        cursor_start: 1,
        resync_required: false,
        returned_rows: 10,
        revision: 10,
        rows: [[10]],
        schema_revision: 1,
        table_id: "default",
        total_rows: 10,
      },
    };

    const next = __analysisTableRowsAdapterTestUtils.tableResourceReducer(
      current,
      {
        advanceCursor: false,
        resource: {
          ...current.visibleTable,
          cursor_end: 11,
          cursor_start: 11,
          returned_rows: 1,
          revision: 11,
          rows: [[11]],
          total_rows: 11,
        },
        type: "append",
      },
    );

    expect(next.cursor).toBe(10);
    expect(next.visibleTable?.cursor_end).toBe(11);
    expect(next.visibleTable?.rows).toEqual([[10], [11]]);
  });

  it("replaces the visible table window for range fetches", () => {
    const current = {
      cursor: 1_000,
      visibleTable: {
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
        cursor_end: 1_000,
        cursor_start: 996,
        resync_required: false,
        returned_rows: 5,
        revision: 1_000,
        rows: [[996], [997], [998], [999], [1_000]],
        schema_revision: 1,
        table_id: "default",
        total_rows: 1_000,
      },
    };

    const next = __analysisTableRowsAdapterTestUtils.tableResourceReducer(
      current,
      {
        advanceCursor: false,
        mode: "replace",
        resource: {
          ...current.visibleTable,
          cursor_end: 250,
          cursor_start: 200,
          returned_rows: 2,
          revision: 1_000,
          rows: [[200], [250]],
        },
        type: "append",
      },
    );

    expect(next.cursor).toBe(1_000);
    expect(next.visibleTable?.rows).toEqual([[200], [250]]);
  });

  it("keeps the visible table when a stale tail cursor returns an empty resync", () => {
    const current = {
      cursor: 473,
      visibleTable: {
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
        cursor_end: 473,
        cursor_start: 469,
        resync_required: false,
        returned_rows: 5,
        revision: 473,
        rows: [[469], [470], [471], [472], [473]],
        schema_revision: 1,
        table_id: "default",
        total_rows: 473,
      },
    };

    const next = __analysisTableRowsAdapterTestUtils.tableResourceReducer(
      current,
      {
        resource: {
          ...current.visibleTable,
          cursor_end: 473,
          cursor_start: 474,
          resync_required: true,
          returned_rows: 0,
          rows: [],
        },
        type: "append",
      },
    );

    expect(next.cursor).toBe(473);
    expect(next.visibleTable).toBe(current.visibleTable);
  });

  it("keeps the visible table when a visible-range fetch returns no rows", () => {
    const current = {
      cursor: 473,
      visibleTable: {
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
        cursor_end: 473,
        cursor_start: 469,
        resync_required: false,
        returned_rows: 5,
        revision: 473,
        rows: [[469], [470], [471], [472], [473]],
        schema_revision: 1,
        table_id: "default",
        total_rows: 473,
      },
    };

    const next = __analysisTableRowsAdapterTestUtils.tableResourceReducer(
      current,
      {
        advanceCursor: false,
        mode: "replace",
        resource: {
          ...current.visibleTable,
          cursor_end: 473,
          cursor_start: 0,
          returned_rows: 0,
          rows: [],
        },
        type: "append",
      },
    );

    expect(next.cursor).toBe(473);
    expect(next.visibleTable).toBe(current.visibleTable);
  });
});
