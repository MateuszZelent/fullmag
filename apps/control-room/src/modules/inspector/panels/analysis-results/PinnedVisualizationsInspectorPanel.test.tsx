import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AnalysisNodeKind } from "@/kernel/analysis-modules/analysisModuleContract";
import { ANALYSIS_FEATURE_MANIFESTS } from "@/kernel/analysis-modules/analysisModuleManifests";
import type { PostprocessingDefinition } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { PinnedVisualizationsInspectorPanel } from "./PinnedVisualizationsInspectorPanel";

const mocks = vi.hoisted(() => ({
  useDefinitions: vi.fn(),
}));

vi.mock("@/kernel/resources/postprocessingDefinitionResources", () => ({
  usePostprocessingDefinitionsResource: mocks.useDefinitions,
}));

const PINNED_GROUP_KIND = "results.pinned_visualizations.root";
const TARGET_MODULE = "analysis.dispersion";
const TARGET_RUN = "run-1";

function schemaFor(moduleId: string, nodeKind: string): string {
  const kind = nodeKind as AnalysisNodeKind;
  return (
    ANALYSIS_FEATURE_MANIFESTS.find((manifest) => manifest.id === moduleId)
      ?.definitionSchemas[kind] ?? `${nodeKind}.v1`
  );
}

function definition(
  id: string,
  label: string,
  {
    moduleId = TARGET_MODULE,
    runId = TARGET_RUN,
    nodeKind = `${moduleId}.mode_visualization`,
    definitionSchema = schemaFor(moduleId, nodeKind),
  }: {
    moduleId?: string;
    runId?: string;
    nodeKind?: string;
    definitionSchema?: string;
  } = {},
): PostprocessingDefinition {
  return {
    data_ref: {
      dataset_id: `dataset-${runId}`,
      dataset_revision: "revision-1",
      field_id: `field-${id}`,
      run_id: runId,
    },
    definition_id: id,
    definition_schema: definitionSchema,
    label,
    module_id: moduleId,
    module_version: "0.1.0",
    node_kind: nodeKind,
    revision: 1,
    settings: {},
  };
}

function pinnedGroupSelection(): Selection {
  const nodeId = "results:run-1:dispersion:pinned";
  return {
    kind: PINNED_GROUP_KIND,
    label: "A label that is not the group title",
    moduleSource: "explorer",
    nodeId,
    objectId: null,
    ref: {
      kind: PINNED_GROUP_KIND,
      moduleId: TARGET_MODULE,
      nodeId,
      runId: TARGET_RUN,
      type: "analysis-pinned-group",
    },
  };
}

describe("PinnedVisualizationsInspectorPanel", () => {
  it("shows only mode definitions owned by the selected run and module", () => {
    mocks.useDefinitions.mockReturnValue({
      data: {
        count: 7,
        definitions: [
          definition("mode-a", "Target mode A"),
          definition("mode-b", "Target mode B"),
          definition("other-run", "Other run mode", { runId: "run-2" }),
          definition("other-module", "Other module mode", { moduleId: "analysis.resonance" }),
          definition("wrong-node-kind", "Wrong node kind", {
            nodeKind: `${TARGET_MODULE}.reference`,
            definitionSchema: schemaFor(
              TARGET_MODULE,
              `${TARGET_MODULE}.mode_visualization`,
            ),
          }),
          definition("wrong-schema", "Wrong mode schema", {
            definitionSchema: `${TARGET_MODULE}.mode_visualization.v2`,
          }),
          definition("imported-reference", "Imported reference", {
            nodeKind: `${TARGET_MODULE}.reference`,
            definitionSchema: `${TARGET_MODULE}.reference.v1`,
          }),
        ],
        scene_revision: 12,
      },
      status: "ready",
    });

    const html = renderToStaticMarkup(
      <PinnedVisualizationsInspectorPanel selection={pinnedGroupSelection()} />,
    );

    expect(html).toMatch(
      /<span class="fm-inspector-metric-card__label">Pinned<\/span><span[^>]*>2<\/span>/,
    );
    expect(html).toContain("Target mode A");
    expect(html).toContain("Target mode B");
    expect(html).not.toContain("Other run mode");
    expect(html).not.toContain("Other module mode");
    expect(html).not.toContain("Wrong node kind");
    expect(html).not.toContain("Wrong mode schema");
    expect(html).not.toContain("Imported reference");
    expect(html).not.toContain("The pinned field is not published by this run");
  });

  it("fails closed for a single unavailable pinned field even when its label matches the group", () => {
    mocks.useDefinitions.mockReturnValue({
      data: {
        count: 1,
        definitions: [definition("mode-a", "Must not leak into an ownerless selection")],
        scene_revision: 12,
      },
      status: "ready",
    });

    const selection: Selection = {
      kind: PINNED_GROUP_KIND,
      label: "Pinned visualizations",
      moduleSource: "explorer",
      nodeId: "results:run-1:dispersion:pinned:missing-field",
      objectId: null,
      ref: null,
    };
    const html = renderToStaticMarkup(
      <PinnedVisualizationsInspectorPanel selection={selection} />,
    );

    expect(html).toContain("The pinned field is not published by this run");
    expect(html).not.toContain("Must not leak into an ownerless selection");
    expect(html).not.toMatch(
      /<span class="fm-inspector-metric-card__label">Pinned<\/span><span[^>]*>1<\/span>/,
    );
  });
});
