import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  ModeCompositionLayer,
  ModeCompositionResource,
} from "@/kernel/visualization/ModeCompositionController";

import {
  ModeCompositionActiveInspectorPanel,
  ModeCompositionObjectInspectorPanel,
  ModeCompositionObjectsInspectorPanel,
  eigenModeLayerAppearanceDefaults,
  legalModeLayerComponents,
  type ModeCompositionInspectorDependencies,
} from "./ModeCompositionInspectors";

function layer(overrides: Partial<ModeCompositionLayer> = {}): ModeCompositionLayer {
  return {
    amplitude_scale: 1,
    animation: {
      enabled: false,
      phase_offset_rad: 0,
      rate_hz: 1,
      synchronized: true,
    },
    appearance: {
      auto_range: true,
      colorbar_visible: true,
      colormap: "coolwarm",
      opacity: 1,
      symmetric_zero: true,
      vector_budget: 512,
      vector_length_scale: 1,
      vectors_visible: false,
    },
    component: "x",
    enabled: true,
    field_id: "field-1",
    layer_id: "mode-layer:film",
    mode: {
      artifact_revision: "artifact-1",
      mode_id: "mode-1",
      raw_mode_index: 1,
      run_id: "run-1",
      sample_id: "sample-1",
      stage_id: "stage-1",
    },
    normalization: "mode_global_max",
    object_id: "film",
    phase_rad: 0,
    representation: "phase_rotated_real",
    target_id: "object:film",
    ...overrides,
  };
}

function resource(
  overrides: Partial<ModeCompositionResource> = {},
): ModeCompositionResource {
  return {
    artifact_revision: "artifact-1",
    composition_id: "composition-1",
    layers: [layer()],
    lifecycle: {
      artifact_revision: 1,
      mesh_revision: 4,
      run_id: "run-1",
      session_id: "session-1",
    },
    phase_clock: { master_rate_hz: 1, synchronized: true },
    revision: 3,
    run_id: "run-1",
    schema_version: "mode-composition.v1",
    stage_id: "stage-1",
    ...overrides,
  };
}

const dependencies: ModeCompositionInspectorDependencies = {
  controller: null,
  compatibleObjects: [
    { objectId: "film", targetId: "object:film", label: "Film" },
    { objectId: "reference", targetId: "object:reference", label: "Reference" },
  ],
  resource: resource(),
  spectrum: {
    samples: [
      {
        label: "Bias 0 mT",
        modes: [
          {
            fieldId: "field-1",
            frequencyHz: 5.2e9,
            modeId: "mode-1",
            residualNorm: 1e-9,
          },
        ],
        sampleId: "sample-1",
      },
    ],
  },
};

describe("ModeComposition inspectors", () => {
  it("uses coolwarm symmetric defaults for signed modal projections and rejects vector phase/abs", () => {
    expect(eigenModeLayerAppearanceDefaults("phase_rotated_real")).toMatchObject({
      colormap: "coolwarm",
      symmetric_zero: true,
    });
    expect(eigenModeLayerAppearanceDefaults("phase")).toMatchObject({
      colormap: "twilight",
      range_min: -Math.PI,
      range_max: Math.PI,
      symmetric_zero: false,
    });
    expect(legalModeLayerComponents("abs")).not.toContain("vector");
    expect(legalModeLayerComponents("phase")).not.toContain("vector");
  });

  it("renders the active composition with a bounded object summary and no legacy overlay controls", () => {
    const html = renderToStaticMarkup(
      <ModeCompositionActiveInspectorPanel
        dependencies={dependencies}
        selection={{
          kind: "results.eigen.composition",
          label: "Active Composition",
          moduleSource: "results-navigator",
          nodeId: "results:composition-1",
          objectId: null,
          ref: {
            compositionId: "composition-1",
            kind: "results.eigen.composition",
            nodeId: "results:composition-1",
            revision: "3",
            type: "mode-composition",
          },
        }}
      />,
    );

    expect(html).toContain("Active Mode Composition");
    expect(html).toContain("composition-1");
    expect(html).toContain("object:film");
    expect(html).toContain("Hide all modal layers");
    expect(html).not.toContain("plot-mode-3d");
    expect(html).not.toContain("analysisFieldOverlay");
  });

  it("renders all compatible objects without fetching a field and shows base replacement as effective ownership", () => {
    const html = renderToStaticMarkup(
      <ModeCompositionObjectsInspectorPanel
        dependencies={dependencies}
        selection={{
          kind: "results.eigen.composition.objects",
          label: "Objects",
          moduleSource: "results-navigator",
          nodeId: "results:composition-1:objects",
          objectId: null,
          ref: {
            compositionId: "composition-1",
            kind: "results.eigen.composition.objects",
            nodeId: "results:composition-1:objects",
            revision: "3",
            type: "mode-composition-objects",
          },
        }}
      />,
    );

    expect(html).toContain("Film");
    expect(html).toContain("Reference");
    expect(html).toContain("Base visualization");
    expect(html).not.toContain("fieldId=");
  });

  it("renders a per-object layer inspector with exact configured/effective ownership and modal controls", () => {
    const html = renderToStaticMarkup(
      <ModeCompositionObjectInspectorPanel
        dependencies={dependencies}
        selection={{
          kind: "results.eigen.composition.object",
          label: "Film",
          moduleSource: "results-navigator",
          nodeId: "results:composition-1:object:film",
          objectId: "film",
          ref: {
            compositionId: "composition-1",
            compositionRevision: "3",
            kind: "results.eigen.composition.object",
            layerId: "mode-layer:film",
            nodeId: "results:composition-1:object:film",
            objectId: "film",
            targetId: "object:film",
            type: "mode-composition-object",
          },
        }}
      />,
    );

    expect(html).toContain("Configured surface");
    expect(html).toContain("Effective surface");
    expect(html).toContain("suppressed by mode layer");
    expect(html).toContain("Mode sample");
    expect(html).toContain("Mode component");
    expect(html).toContain("Mode representation");
    expect(html).toContain("Mode palette");
    expect(html).toContain("Phase (rad)");
    expect(html).toContain("Animation rate (Hz)");
    expect(html).toContain("Enable mode layer");
    expect(html).not.toContain("Disable magnetization texture");
  });
});
