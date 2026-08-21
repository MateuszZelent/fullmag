import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SelectionExpressionBuilder } from "./SelectionExpressionBuilder";

describe("SelectionExpressionBuilder", () => {
  it("renders nested typed selectors without flattening their identity", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectionExpressionBuilder, {
        expression: {
          kind: "and",
          expressions: [
            { kind: "in_object", object_id: "film" },
            { kind: "ref", selection_id: "left-edge" },
          ],
        },
        objectId: "film",
        onChange: vi.fn(),
      }),
    );

    expect(markup).toContain('data-selection-expression-kind="and"');
    expect(markup).toContain('data-selection-expression-kind="in_object"');
    expect(markup).toContain('data-selection-expression-kind="ref"');
    expect(markup).toContain('value="left-edge"');
  });

  it("renders generated interval selectors as typed editable controls", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectionExpressionBuilder, {
        expression: {
          kind: "between",
          closed: "both",
          lower: -0.5,
          upper: 0.5,
          value: { kind: "magnetization_component", component: "x" },
        },
        objectId: "film",
        onChange: vi.fn(),
      }),
    );
    expect(markup).toContain('data-selection-expression-kind="between"');
    expect(markup).toContain('data-selection-scalar-kind="magnetization_component"');
    expect(markup).toContain("Lower bound");
    expect(markup).toContain("Closed both");
  });

  it("renders geometry and boolean selector operators recursively", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectionExpressionBuilder, {
        expression: {
          kind: "inside_geometry",
          boundary: {
            absolute_tolerance_m: 0,
            kind: "inclusive",
            relative_tolerance: 0,
          },
          frame: { kind: "world" },
          geometry: {
            kind: "union",
            a: { kind: "sphere", center_m: [0, 0, 0], radius_m: 1 },
            b: { kind: "box", center_m: [0, 0, 0], size_m: [1, 1, 1] },
          },
          sampling: { kind: "dof_point" },
        },
        objectId: "film",
        onChange: vi.fn(),
      }),
    );
    expect(markup).toContain('data-selection-geometry-kind="union"');
    expect(markup).toContain('data-selection-geometry-kind="sphere"');
    expect(markup).toContain('data-selection-geometry-kind="box"');
  });
});
