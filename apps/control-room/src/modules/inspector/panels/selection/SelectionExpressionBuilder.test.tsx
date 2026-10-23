import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { SelectionExpressionBuilder } from "./SelectionExpressionBuilder";
import type { FrozenSpinsSelectionExpression } from "@/kernel/api/apiTypes";
import type { SelectionReferenceCatalog } from "./selectionReferenceCatalog";

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

  it("requires explicit region and named-selection choices instead of placeholder IDs", async () => {
    const harness = await mountReferenceBuilder({ kind: "in_object", object_id: "film" });
    try {
      expect(harness.changed).not.toHaveBeenCalled();
      await harness.change("Operator", "in_region");
      expect(harness.expression()).toMatchObject({ region_id: "" });
      expect(harness.field("Region ID").value).toBe("");
      await harness.change("Region ID", "edge/%25");
      expect(harness.expression()).toMatchObject({ object_id: "film", region_id: "edge/%25" });
      await harness.change("Object ID", "other");
      expect(harness.expression()).toMatchObject({ object_id: "other", region_id: "" });
      await harness.change("Region ID", "edge/%25");
      expect(harness.expression()).toMatchObject({ region_id: "" });
      await harness.change("Operator", "ref");
      expect(harness.expression()).toEqual({ kind: "ref", selection_id: "" });
      await harness.change("Selection ID", "named/%2F");
      expect(harness.expression()).toEqual({ kind: "ref", selection_id: "named/%2F" });
    } finally { await harness.dispose(); }
  });

  it("preserves a missing current ID through an unconfirmed catalog and later recovery", async () => {
    const harness = await mountReferenceBuilder({ kind: "ref", selection_id: "missing/%25" });
    try {
      const select = harness.field("Selection ID");
      expect(select.value).toBe("missing/%25");
      expect(harness.container.textContent).toContain("Unavailable: missing/%25");
      await harness.catalog({ ...referenceCatalog, ready: false });
      expect(harness.field("Selection ID")).toBe(select);
      expect(select.disabled).toBe(true);
      await harness.change("Selection ID", "named/%2F");
      expect(harness.changed).not.toHaveBeenCalled();
      await harness.catalog({ ...referenceCatalog, selections: [{ id: "missing/%25", label: "Recovered name" }] });
      expect(harness.field("Selection ID")).toBe(select);
      expect(select.value).toBe("missing/%25");
      expect(harness.changed).not.toHaveBeenCalled();
    } finally { await harness.dispose(); }
  });

  it("does not offer creation of unqualified imported-solid selectors", async () => {
    const harness = await mountReferenceBuilder(geometryExpression({ kind: "box", center_m: [0, 0, 0], size_m: [1, 1, 1] }));
    try {
      expect(harness.field("Geometry kind").textContent).not.toContain("Imported solid");
      await harness.change("Geometry kind", "imported_solid");
      expect(harness.changed).not.toHaveBeenCalled();
    } finally { await harness.dispose(); }
  });

  it.each(["imported", "future"])("preserves an unsupported %s selector read-only", async (kind) => {
    const expression = kind === "imported" ? geometryExpression({ kind: "imported_solid", asset_id: "original/%25" })
      : { kind: "future_selector", keep: "original/%25" } as unknown as FrozenSpinsSelectionExpression;
    const before = JSON.stringify(expression);
    const harness = await mountReferenceBuilder(expression);
    try {
      expect(harness.field("Operator").value).toBe("advanced");
      expect(harness.field("Operator").disabled).toBe(true);
      expect(harness.container.textContent).toContain("original/%25");
      await harness.change("Operator", "all_magnetic");
      expect(harness.changed).not.toHaveBeenCalled();
      expect(JSON.stringify(harness.expression())).toBe(before);
    } finally { await harness.dispose(); }
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

const referenceCatalog: SelectionReferenceCatalog = {
  ready: true,
  objects: [{ id: "film", label: "Film", regions: [{ id: "edge/%25", label: "Edge" }] }, { id: "other", label: "Other", regions: [] }],
  selections: [{ id: "named/%2F", label: "Named selection" }],
};

function geometryExpression(geometry: Extract<FrozenSpinsSelectionExpression, { kind: "inside_geometry" }>["geometry"]): FrozenSpinsSelectionExpression {
  return { kind: "inside_geometry", geometry, frame: { kind: "world" }, sampling: { kind: "dof_point" }, boundary: { kind: "inclusive", absolute_tolerance_m: 0, relative_tolerance: 0 } };
}

async function mountReferenceBuilder(initial: FrozenSpinsSelectionExpression) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  let catalog = referenceCatalog;
  let current = initial;
  const changed = vi.fn();
  function Probe() {
    const [expression, setExpression] = useState(initial);
    current = expression;
    return <SelectionExpressionBuilder expression={expression} objectId="film" referenceCatalog={catalog} onChange={(next) => { changed(next); setExpression(next); }} />;
  }
  const render = () => act(async () => root.render(<Probe />));
  await render();
  const field = (label: string) => {
    let result: TestElement | undefined;
    const visit = (node: TestNode) => {
      if (node instanceof TestElement && node.getAttribute("aria-label") === label) result ??= node;
      node.childNodes.forEach(visit);
    };
    visit(container);
    if (!result) throw new Error(`Missing field ${label}`);
    return result;
  };
  return {
    container, field, changed, expression: () => current,
    change: (label: string, value: string) => act(async () => { const select = field(label); select.value = value; select.dispatchEvent(new TestEvent("change", { bubbles: true })); }),
    catalog: async (next: SelectionReferenceCatalog) => { catalog = next; await render(); },
    dispose: async () => { await act(async () => root.unmount()); dom.restore(); },
  };
}

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
