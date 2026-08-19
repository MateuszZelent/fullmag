import { describe, expect, it } from "vitest";

import type {
  FrequencyDomainJsonArtifactResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type {
  ModeCompositionController,
  ModeCompositionResource,
} from "@/kernel/visualization/ModeCompositionController";

import {
  modeCompositionInspectorDependenciesFromResources,
  modeCompositionSpectrumFromArtifact,
} from "./modeCompositionInspectorDependencies";

const controller = {} as Pick<
  ModeCompositionController,
  "assign" | "mutate" | "remove" | "setPhaseClock" | "updateLayer"
>;

const composition = {
  artifact_revision: "artifact-1",
  composition_id: "composition-1",
  layers: [],
  lifecycle: { artifact_revision: 1, mesh_revision: 2, run_id: "run-1", session_id: "session-1" },
  phase_clock: { master_rate_hz: 1, synchronized: true },
  revision: 4,
  run_id: "run-1",
  schema_version: "mode-composition.v1",
  stage_id: "stage-1",
} as ModeCompositionResource;

const scene = {
  objects: [
    { id: "film", name: "Film" },
    { id: "reference", name: "Reference" },
  ],
} as SceneResource;

const spectrumArtifact = {
  payload: {
    samples: [
      {
        modes: [
          {
            branch_id: 0,
            component_participation: { objects: [{ object_id: "film" }] },
            mode_field_id: "mode-field-1",
            frequency_hz: 5.2e9,
            mode_id: "mode-1",
            raw_mode_index: 1,
            residual_relative_l2: 1e-9,
          },
        ],
        sample_id: "sample-1",
        sample_index: 0,
      },
    ],
  },
} as unknown as FrequencyDomainJsonArtifactResource;

describe("modeCompositionInspectorDependenciesFromResources", () => {
  it("builds non-null registry dependencies from spectrum.v3 and canonical scene targets", () => {
    const dependencies = modeCompositionInspectorDependenciesFromResources({
      composition,
      controller,
      scene,
      spectrumArtifact,
    });

    expect(dependencies).toMatchObject({
      compatibleObjects: [{ label: "Film", objectId: "film", targetId: "object:film" }],
      controller,
      resource: composition,
      spectrum: {
        samples: [{
          label: "Sample 0",
          modes: [{
            branchId: "0",
            fieldId: "mode-field-1",
            frequencyHz: 5.2e9,
            modeId: "mode-1",
            rawModeIndex: 1,
            residualNorm: 1e-9,
          }],
          sampleId: "sample-1",
        }],
      },
    });
  });

  it("preserves a non-null dependency envelope before resources are available", () => {
    const dependencies = modeCompositionInspectorDependenciesFromResources({
      composition: null,
      controller,
      scene: null,
      spectrumArtifact: null,
    });

    expect(dependencies).toEqual({
      compatibleObjects: [],
      controller: null,
      resource: null,
      spectrum: null,
    });
  });

  it("preserves published per-component participation for global and object spectrum scopes", () => {
    const spectrum = modeCompositionSpectrumFromArtifact({
      payload: {
        samples: [{
          sample_id: "sample-1",
          modes: [{
            mode_id: "mode-1",
            frequency_hz: 5.2e9,
            component_participation: {
              status: "ready",
              global: { total: 1, x: 0.2, y: 0.3, z: 0.5 },
              objects: [{
                object_id: "film",
                total_fraction: 0.6,
                components: { total: 0.6, x: 0.1, y: 0.2, z: 0.3 },
              }],
            },
          }],
        }],
      },
    } as unknown as FrequencyDomainJsonArtifactResource);

    expect(spectrum?.samples[0]?.modes[0]?.participation).toEqual({
      global: { total: 1, x: 0.2, y: 0.3, z: 0.5 },
      objects: [{
        objectId: "film",
        fractions: { total: 0.6, x: 0.1, y: 0.2, z: 0.3 },
      }],
    });
  });
});
