import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TableColumnList,
  nextYAxisIdsForToggle,
  sanitizeYAxisIdsForUnitLimit,
} from "./TableColumnList";

const columns = [
  { column_id: "step", label: "step", unit: "1" },
  { column_id: "mx", label: "mx", unit: "1" },
];

describe("TableColumnList", () => {
  it("renders compact descriptors without a table payload", () => {
    const html = renderToStaticMarkup(
      <TableColumnList
        columns={columns}
        onSelectXAxis={() => undefined}
        onSelectedSeriesIdsChange={() => undefined}
        seriesIdForColumn={(columnId) => `data.table:default:step:${columnId}`}
        xAxisId="step"
        xAxisRadioName="fm-analysis-plots-x-axis"
        selectedSeriesIds={[]}
      />,
    );

    expect(html).toContain('name="fm-analysis-plots-x-axis"');
    expect(html).toContain("mx");
  });

  it("allows disabling the last selected Y axis", () => {
    expect(nextYAxisIdsForToggle(["mx"], "mx", false)).toEqual([]);
    expect(nextYAxisIdsForToggle(["mx", "my"], "mx", false)).toEqual(["my"]);
    expect(nextYAxisIdsForToggle(["mx"], "my", true)).toEqual(["mx", "my"]);
  });

  it("does not allow selecting a third incompatible Y-axis unit", () => {
    const units = [
      { column_id: "mx", unit: "1" },
      { column_id: "e_total", unit: "J" },
      { column_id: "max_torque", unit: "A/m" },
    ];

    expect(
      nextYAxisIdsForToggle(["mx", "e_total"], "max_torque", true, {
        columns: units,
        xAxisId: "step",
      }),
    ).toEqual(["mx", "e_total"]);
  });

  it("sanitizes pre-existing Y-axis selections to two unit groups", () => {
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

  it("keeps the final selected checkbox enabled", () => {
    const html = renderToStaticMarkup(
      <TableColumnList
        columns={[columns[1]!]}
        onSelectXAxis={() => undefined}
        onSelectedSeriesIdsChange={() => undefined}
        seriesIdForColumn={(columnId) => `data.table:default:step:${columnId}`}
        xAxisId="step"
        xAxisRadioName="fm-analysis-plots-x-axis"
        selectedSeriesIds={["data.table:default:step:mx"]}
      />,
    );

    expect(html).not.toContain('class="fm-analysis-plots__checkbox" disabled=""');
  });

  it("disables third-unit Y-axis checkboxes", () => {
    const html = renderToStaticMarkup(
      <TableColumnList
        columns={[
          { column_id: "mx", label: "mx", unit: "1" },
          { column_id: "e_total", label: "E total", unit: "J" },
          { column_id: "max_torque", label: "max torque", unit: "A/m" },
        ]}
        onSelectXAxis={() => undefined}
        onSelectedSeriesIdsChange={() => undefined}
        seriesIdForColumn={(columnId) => `data.table:default:step:${columnId}`}
        xAxisId="step"
        xAxisRadioName="fm-analysis-plots-x-axis"
        selectedSeriesIds={[
          "data.table:default:step:mx",
          "data.table:default:step:e_total",
        ]}
      />,
    );

    expect(html).toContain('title="Select at most two Y-axis unit groups"');
  });
});
