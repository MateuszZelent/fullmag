import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

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

  it("renders validation feedback for empty clauses and invalid bounds", () => {
    const emptyAndMarkup = renderToStaticMarkup(
      createElement(SelectionExpressionBuilder, {
        expression: {
          kind: "and",
          expressions: [],
        },
        objectId: "film",
        onChange: vi.fn(),
      }),
    );
    expect(emptyAndMarkup).toContain("At least one sub-expression clause is required.");

    const invalidBetweenMarkup = renderToStaticMarkup(
      createElement(SelectionExpressionBuilder, {
        expression: {
          kind: "between",
          closed: "both",
          lower: 5.0,
          upper: 1.0,
          value: { kind: "constant", value: 0 },
        },
        objectId: "film",
        onChange: vi.fn(),
      }),
    );
    expect(invalidBetweenMarkup).toContain("Lower bound cannot exceed upper bound.");

    const emptyObjectMarkup = renderToStaticMarkup(
      createElement(SelectionExpressionBuilder, {
        expression: {
          kind: "in_object",
          object_id: "",
        },
        objectId: "film",
        onChange: vi.fn(),
      }),
    );
    expect(emptyObjectMarkup).toContain("Object ID cannot be empty.");
  });

  it("preserves the numeric input and focus while adopting a canonical value", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const renderBuilder = (lower: number) => (
      <SelectionExpressionBuilder
        expression={{
          closed: "both",
          kind: "between",
          lower,
          upper: 2,
          value: { kind: "constant", value: 0 },
        }}
        objectId="film"
        onChange={vi.fn()}
      />
    );
    try {
      await act(async () => root.render(renderBuilder(0)));
      const input = findNumberInputs(container)[1]!;
      input.focus();
      await act(async () => root.render(renderBuilder(1)));
      expect(findNumberInputs(container)[1]).toBe(input);
      expect(dom.document.activeElement).toBe(input);
      expect(input.value).toBe("1");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function findNumberInputs(root: TestNode): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && node.tagName === "INPUT") {
      found.push(node);
    }
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}
