import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { resolveInspectorRoute } from "../../inspectorRouteCatalog";

function renderRoute(kind: string, ref: Record<string, unknown>, label: string) {
  const route = resolveInspectorRoute(kind);
  if (!route) throw new Error(`Missing route for ${kind}`);
  return renderToStaticMarkup(
    createElement(route.component, {
      selection: {
        kind,
        label,
        moduleSource: "explorer",
        nodeId: `results:run:run-7:${kind}`,
        objectId: null,
        ref: {
          ...ref,
          kind,
          nodeId: `results:run:run-7:${kind}`,
          type: "postprocessing",
        } as never,
      },
    }),
  );
}

describe("routed postprocessing Inspectors", () => {
  it("renders Table semantics from the actual route component", () => {
    const html = renderRoute(
      "results.tables.definition",
      {
        catalogRevision: 12,
        contractGap: null,
        definitionKind: "table",
        freshness: "fresh",
        ownerId: "energy",
        ownerKind: "table",
        ownerReadiness: "available-ready",
        ownerResourceRevision: 8,
        ownerSchemaRevision: 3,
        resourceRef: "table:energy",
      },
      "energy",
    );

    expect(html).toContain("Table ID");
    expect(html).toContain("Schema revision");
    expect(html).toContain("Freshness");
    expect(html).toContain("Read-only table resource inspection");
    expect(html).not.toContain("Dataset / resource");
  });

  it("renders Export semantics from the actual route component", () => {
    const html = renderRoute(
      "results.exports.definition",
      {
        catalogRevision: "artifacts:17",
        contractGap: null,
        definitionKind: "export",
        freshness: "fresh",
        ownerId: "run-7/energy.csv",
        ownerKind: "artifact",
        ownerReadiness: "available-ready",
        ownerResourceRevision: "artifacts:17",
        ownerSchemaRevision: null,
        resourceRef: "artifact:run-7/energy.csv",
      },
      "energy.csv",
    );

    expect(html).toContain("Artifact kind");
    expect(html).toContain("Artifact path");
    expect(html).toContain("Freshness");
    expect(html).toContain("Read-only artifact provenance inspection");
    expect(html).not.toContain("Schema revision");
  });

  it("renders Analysis View and Derived Value contract gaps with different semantics", () => {
    const viewHtml = renderRoute(
      "results.analysis_views.definition",
      {
        catalogRevision: null,
        contractGap: "No persistent owner resource is published for user-defined postprocessing definitions.",
        definitionKind: "analysis_view",
        freshness: "unknown",
        ownerId: null,
        ownerKind: null,
        ownerReadiness: "unavailable",
        ownerResourceRevision: null,
        ownerSchemaRevision: null,
        resourceRef: null,
      },
      "Energy view",
    );
    const valueHtml = renderRoute(
      "results.derived_values.definition",
      {
        catalogRevision: null,
        contractGap: "No persistent owner resource is published for user-defined postprocessing definitions.",
        definitionKind: "derived_value",
        freshness: "unknown",
        ownerId: null,
        ownerKind: null,
        ownerReadiness: "unavailable",
        ownerResourceRevision: null,
        ownerSchemaRevision: null,
        resourceRef: null,
      },
      "Mean energy",
    );

    expect(viewHtml).toContain("View definition");
    expect(viewHtml).toContain("Source dataset");
    expect(viewHtml).toContain("Contract gap");
    expect(valueHtml).toContain("Operation");
    expect(valueHtml).toContain("Output unit");
    expect(valueHtml).toContain("Contract gap");
    expect(viewHtml).not.toContain("Operation");
    expect(valueHtml).not.toContain("View definition");
  });

  it.each([
    ["loading", "loading"],
    ["stale", "stale"],
    ["error", "error"],
    ["unavailable", "unavailable"],
  ] as const)("does not publish a stale/error owner as ready (%s)", (ownerReadiness, expectedResource) => {
    const html = renderRoute(
      "results.exports.definition",
      {
        catalogRevision: "artifacts:17",
        contractGap: "Artifact catalog is not current.",
        definitionKind: "export",
        freshness: ownerReadiness === "stale" ? "stale" : "unknown",
        ownerId: "run-7/energy.csv",
        ownerKind: "artifact",
        ownerReadiness,
        ownerResourceRevision: "artifacts:17",
        ownerSchemaRevision: null,
        resourceRef: "artifact:run-7/energy.csv",
      },
      "energy.csv",
    );

    expect(html).toContain(`>${expectedResource}<`);
    expect(html).not.toContain(">published<");
  });
});
