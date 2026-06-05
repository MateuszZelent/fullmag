import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TableColumnList,
  nextYAxisIdsForToggle,
  sanitizeYAxisIdsForUnitLimit,
} from "./TableColumnList";

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
  cursor_end: 1,
  cursor_start: 1,
  resync_required: false,
  returned_rows: 1,
  revision: 1,
  rows: [[1]],
  schema_revision: 1,
  table_id: "default",
  total_rows: 1,
};

describe("TableColumnList", () => {
  it("uses a caller-provided X-axis radio group name per rendered surface", () => {
    const html = renderToStaticMarkup(
      <TableColumnList
        onSelectXAxis={() => undefined}
        onToggleYAxis={() => undefined}
        table={table}
        xAxisId="step"
        xAxisRadioName="fm-analysis-plots-x-axis"
        yAxisIds={[]}
      />,
    );

    expect(html).toContain('name="fm-analysis-plots-x-axis"');
    expect(html).not.toContain('name="fm-analysis-x-axis"');
  });

  it("does not allow disabling the last selected Y axis", () => {
    expect(nextYAxisIdsForToggle(["mx"], "mx", false)).toEqual(["mx"]);
    expect(nextYAxisIdsForToggle(["mx", "my"], "mx", false)).toEqual(["my"]);
    expect(nextYAxisIdsForToggle(["mx"], "my", true)).toEqual(["mx", "my"]);
  });

  it("does not allow selecting a third incompatible Y-axis unit", () => {
    const columns = [
      { column_id: "mx", unit: "1" },
      { column_id: "e_total", unit: "J" },
      { column_id: "max_torque", unit: "A/m" },
    ];

    expect(
      nextYAxisIdsForToggle(["mx", "e_total"], "max_torque", true, {
        columns,
        xAxisId: "step",
      }),
    ).toEqual(["mx", "e_total"]);
    expect(
      nextYAxisIdsForToggle(["mx", "e_total"], "my", true, {
        columns: [...columns, { column_id: "my", unit: "1" }],
        xAxisId: "step",
      }),
    ).toEqual(["mx", "e_total", "my"]);
  });

  it("sanitizes pre-existing Y-axis selections to the rendered unit groups", () => {
    expect(
      sanitizeYAxisIdsForUnitLimit(
        ["t", "mx", "my", "e_total", "max_torque"],
        [
          { column_id: "t", unit: "s" },
          { column_id: "mx", unit: "1" },
          { column_id: "my", unit: "1" },
          { column_id: "e_total", unit: "J" },
          { column_id: "max_torque", unit: "A/m" },
        ],
        "step",
      ),
    ).toEqual(["t", "mx", "my"]);
  });

  it("disables the last selected Y-axis checkbox in markup", () => {
    const html = renderToStaticMarkup(
      <TableColumnList
        onSelectXAxis={() => undefined}
        onToggleYAxis={() => undefined}
        table={{
          ...table,
          columns: [
            table.columns[0],
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
        }}
        xAxisId="step"
        xAxisRadioName="fm-analysis-plots-x-axis"
        yAxisIds={["mx"]}
      />,
    );

    expect(html).toContain('class="fm-analysis-plots__checkbox" disabled=""');
  });

  it("disables third-unit Y-axis checkboxes in markup", () => {
    const html = renderToStaticMarkup(
      <TableColumnList
        onSelectXAxis={() => undefined}
        onToggleYAxis={() => undefined}
        table={{
          ...table,
          columns: [
            {
              ...table.columns[0],
              column_id: "mx",
              label: "mx",
              unit: "1",
            },
            {
              ...table.columns[0],
              column_id: "e_total",
              label: "E total",
              unit: "J",
            },
            {
              ...table.columns[0],
              column_id: "max_torque",
              label: "max torque",
              unit: "A/m",
            },
          ],
        }}
        xAxisId="step"
        xAxisRadioName="fm-analysis-plots-x-axis"
        yAxisIds={["mx", "e_total"]}
      />,
    );

    expect(html).toContain('title="Select at most two Y-axis unit groups"');
    expect(html).toContain('class="fm-analysis-plots__checkbox" disabled=""');
  });
});
