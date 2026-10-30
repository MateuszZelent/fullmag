import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const inspectorTab = vi.hoisted(() => ({ value: "overview" }));
vi.mock("../../InspectorTabState", () => ({ useInspectorActiveTab: () => inspectorTab.value }));
afterEach(() => { inspectorTab.value = "overview"; });

vi.mock("@/kernel/KernelContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/kernel/KernelContext")>()),
  useKernel: () => ({ commands: { execute: vi.fn() } }),
}));

vi.mock("@/kernel/resources/studyRuntimeResources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/resources/studyRuntimeResources")>();
  const unavailable = () => ({ data: null, status: "unavailable" });
  return {
    ...actual,
    useFrequencyDomainManifestResource: unavailable,
    useFrequencyDomainResponseCancelRequestedResource: unavailable,
    useFrequencyDomainResponseProgressResource: unavailable,
    useFrequencyDomainResponseSweepResource: unavailable,
    useFrequencyDomainEigenBranchesResource: unavailable,
    useFrequencyDomainEigenDispersionResource: unavailable,
    useFrequencyDomainEigenSpectrumResource: unavailable,
  };
});

vi.mock("@/kernel/resources/analyticReferenceResources", () => ({
  useAnalyticReferenceModelsResource: () => ({ data: null, status: "unavailable" }),
}));

import { resolveInspectorRoute } from "../../inspectorRouteCatalog";
import { PhysicsFirstResultInspectorFrame } from "./PhysicsFirstResultInspectorPanel";

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

function renderFrequencyRoute(
  kind: string,
  ref: Record<string, unknown>,
  label: string,
) {
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
          type: "frequency-domain",
        } as never,
      },
    }),
  );
}

describe("routed postprocessing Inspectors", () => {
  it("exposes reference import on the legacy dispersion Data route with exact result ownership", () => {
    inspectorTab.value = "data";
    const html = renderFrequencyRoute(
      "results.eigen.dispersion",
      {
        analysisRunId: "run-7",
        analysisStageId: "stage-2",
        artifactRevision: "revision-3",
        resourceRef: "artifact-revision:revision-3",
      },
      "Dispersion",
    );

    expect(html).toContain("Import reference");
    expect(html).toContain("Reference file");
  });

  it("keeps reference import unavailable on the dispersion Data route without an owner", () => {
    inspectorTab.value = "data";
    const html = renderFrequencyRoute(
      "results.eigen.dispersion",
      { artifactRevision: "revision-3" },
      "Dispersion",
    );

    expect(html).toContain("requires a dispersion result with a published run, stage, and artifact revision");
    expect(html).not.toContain("Reference file");
  });

  it.each(["overview", "data", "provenance", "diagnostics"])(
    "retains exact owner metadata independently of the visible tab (%s)", (tab) => {
      inspectorTab.value = tab;
      const html = renderToStaticMarkup(createElement(PhysicsFirstResultInspectorFrame, {
        selection: {
          kind: "results.dispersion.modal.mode_at_k", label: "Selected mode",
          moduleSource: "explorer", nodeId: "mode-7", objectId: null,
          ref: {
            type: "frequency-domain", analysisRunId: "run-7", analysisStageId: "stage-2",
            artifactRevision: "revision-3",
          } as never,
        },
      }));
      expect(html).toContain('data-analysis-run-id="run-7"');
      expect(html).toContain('data-analysis-stage-id="stage-2"');
      expect(html).toContain('data-artifact-revision="revision-3"');
      expect(html).toContain(`data-result-tab="${tab}"`);
    },
  );

  it("delegates an owned provenance panel without duplicating generic metadata", () => {
    inspectorTab.value = "provenance";
    const html = renderToStaticMarkup(createElement(PhysicsFirstResultInspectorFrame, {
      contentTabs: ["provenance"],
      selection: {
        kind: "results.dispersion.modal.mode_at_k", label: "Selected mode",
        moduleSource: "explorer", nodeId: "mode-7", objectId: null, ref: null,
      },
    }, createElement("p", null, "Exact selected mode provenance")));
    expect(html).toContain("Exact selected mode provenance");
    expect(html).not.toContain("Artifact provenance");
  });

  it("renders the selected result status facets and contract gap truthfully", () => {
    inspectorTab.value = "diagnostics";
    const html = renderFrequencyRoute(
      "results.resonance.driven.spectrum",
      {
        availability: "partial",
        contractGap: "Drive observable evidence is incomplete.",
        executionState: "running",
        resourceRef: "artifact-revision:response-r3",
        resourceState: "stale",
        studyProduct: "driven_response",
      },
      "Driven response spectrum",
    );

    expect(html).toContain(">stale<");
    expect(html).toContain(">running<");
    expect(html).toContain(">partial<");
    expect(html).toContain("Drive observable evidence is incomplete.");
  });

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
    expect(html).toContain("Open this published table in Analysis");
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
