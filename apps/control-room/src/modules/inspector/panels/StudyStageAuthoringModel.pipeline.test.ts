import { describe, expect, it } from "vitest";

import { readStudyStageSource } from "@/shared/domain/study/studyStageSource";
import {
  buildStudyPipelineStageMergePatch, buildStudyStagesMergePatch, createStudyStageDraft, stageTextureAssignmentsValue,
  studyStageDraftToSceneStage,
} from "./StudyStageAuthoringModel";
import { createPipelineStudyStageDrafts } from "./studyPipelineStageDrafts";

const reset = {
  schema_version: "fullmag.magnetization-assignments.v1",
  assignments: [{ object_id: "body", region_id: null, initializer: { kind: "uniform", direction: [1, 0, 0] } }],
};

function fixture() {
  const relax = {
    node_kind: "primitive",
    id: "relax-b",
    stage_kind: "relax",
    label: "Second relaxation",
    source: "script_imported",
    payload: {
      stage_id: "capture-relax-b",
      entrypoint_kind: "study_stage_relax",
      relax_algorithm: "llg_overdamped",
      max_steps: "50",
      torque_tolerance: "1e-4",
      solver: "rk4",
      fixed_timestep: "1e-15",
      magnetization_assignments: reset,
      future_setting: { preserved: true },
    },
  };
  const run = {
    node_kind: "primitive",
    id: "run-c",
    stage_kind: "run",
    label: "Readout",
    payload: {
      stage_id: "capture-run-c",
      until_seconds: "2e-12",
      output_every_seconds: 1e-14,
      autosave: {
        kind: "stage_autosave",
        format: "zarr",
        layout: "continuous",
        target: "main",
        fields: [{ kind: "field_autosave", quantity: "m", every_seconds: 1e-12, future_option: "retain" }],
      },
    },
  };
  const group = { node_kind: "group", id: "batch", label: "Batch", children: [relax, run] };
  const pipeline = { version: "study_pipeline.v2", nodes: [group] };
  const scene = { study: { study_pipeline: pipeline, stages: [{ id: "dormant" }] } };
  const drafts = createPipelineStudyStageDrafts(readStudyStageSource(scene.study).entries);
  return { drafts, group, pipeline, relax, run, scene };
}

describe("canonical pipeline stage authoring", () => {
  it("updates only the chosen nested payload and preserves reset events and capture identity", () => {
    const { drafts, group, pipeline, relax, run, scene } = fixture();
    const patch = buildStudyPipelineStageMergePatch({ ...drafts[0], maxSteps: "75" }, 12, scene);

    expect(patch).toEqual({
      kind: "merge_patch", base_revision: 12, merge_patch: {
        study: { study_pipeline: { ...pipeline, nodes: [{
          ...group, children: [{ ...relax, payload: { ...relax.payload, max_steps: "75" } }, run],
        }] } },
      },
    });
    expect(relax.payload.max_steps).toBe("50");
  });

  it("saves a stage-local reset and disables the leaf without altering the script event", () => {
    const { drafts, group, pipeline, relax, run, scene } = fixture();
    const local = stageTextureAssignmentsValue([{
      object_id: "body", region_id: "core", initializer: { kind: "uniform", value: [0, 0, 1] },
    }]);
    const patch = buildStudyPipelineStageMergePatch({
      ...drafts[0], stageMagnetizationAssignments: local, stageEnabled: false,
    }, 12, scene);
    expect(patch).toEqual({
      kind: "merge_patch", base_revision: 12, merge_patch: {
        study: { study_pipeline: { ...pipeline, nodes: [{
          ...group, children: [{ ...relax, enabled: false, payload: {
            ...relax.payload, stage_magnetization_assignments: local,
          } }, run],
        }] } },
      },
    });
  });

  it("upgrades only on the first authored local reset and removes it without deleting the stage", () => {
    const { pipeline, relax, scene } = fixture();
    pipeline.version = "study_pipeline.v1";
    Reflect.deleteProperty(relax.payload, "magnetization_assignments");
    const [draft] = createPipelineStudyStageDrafts(readStudyStageSource(scene.study).entries);
    const local = stageTextureAssignmentsValue([
      { object_id: "body", region_id: null, initializer: null },
    ]);
    const transaction = buildStudyPipelineStageMergePatch({ ...draft, stageMagnetizationAssignments: local }, 12, scene);
    const saved = (transaction as unknown as { merge_patch: typeof scene }).merge_patch;
    expect(saved.study.study_pipeline.version).toBe("study_pipeline.v2");

    const [savedDraft] = createPipelineStudyStageDrafts(readStudyStageSource(saved.study).entries);
    const removal = buildStudyPipelineStageMergePatch({
      ...savedDraft, stageMagnetizationAssignments: undefined,
    }, 13, saved);
    const restored = (removal as unknown as { merge_patch: typeof scene }).merge_patch;
    expect(restored.study.study_pipeline.nodes[0].children[0]).toEqual(relax);
  });

  it("round-trips local and independent assignments on a disabled flat stage", () => {
    const local = stageTextureAssignmentsValue([{ object_id: "body", region_id: "core", initializer: null }]);
    const source = { kind: "run", stage_id: "run", until_seconds: "1e-12", enabled: false,
      magnetization_assignments: reset, stage_magnetization_assignments: local };
    const draft = createStudyStageDraft(source, 0);
    expect(studyStageDraftToSceneStage(draft)).toMatchObject(source);
    const authored = { ...source, fixed_timestep: "1e-14", future_setting: { keep: true } };
    const scene = { study: { stages: [authored] } };
    expect(buildStudyStagesMergePatch([{ ...draft, stageEnabled: true }], 12, scene)).toEqual({
      kind: "merge_patch", base_revision: 12,
      merge_patch: { study: { stages: [{ ...authored, enabled: true }] } },
    });
  });

  it("replaces the old algorithm alias and removes incompatible LLG controls", () => {
    const { drafts, group, pipeline, relax, run, scene } = fixture();
    const patch = buildStudyPipelineStageMergePatch({ ...drafts[0], algorithm: "nonlinear_cg" }, 12, scene);
    const { relax_algorithm: _old, solver: _solver, fixed_timestep: _dt, ...retained } = relax.payload;
    expect(patch).toMatchObject({ merge_patch: { study: { study_pipeline: {
      ...pipeline, nodes: [{
        ...group, children: [{ ...relax, payload: { ...retained, algorithm: "nonlinear_cg" } }, run],
      }],
    } } } });
    const payload = (patch as unknown as { merge_patch: { study: { study_pipeline: typeof pipeline } } })
      .merge_patch.study.study_pipeline.nodes[0].children[0].payload;
    expect(payload).toEqual({ ...retained, algorithm: "nonlinear_cg" });
  });

  it("edits Run duration and an autosave cadence without normalizing untouched payloads", () => {
    const { drafts, group, pipeline, relax, run, scene } = fixture();
    const draft = {
      ...drafts[1], untilSeconds: "4 ps",
      stageAutosave: {
        ...drafts[1].stageAutosave,
        fields: [{ ...drafts[1].stageAutosave.fields[0], cadence: "2e-12" }],
      },
    };
    expect(buildStudyPipelineStageMergePatch(draft, 12, scene)).toEqual({
      kind: "merge_patch", base_revision: 12, merge_patch: {
        study: { study_pipeline: { ...pipeline, nodes: [{
          ...group, children: [relax, { ...run, payload: {
            ...run.payload, until_seconds: "4e-12",
            autosave: { ...run.payload.autosave, fields: [
              { ...run.payload.autosave.fields[0], every_seconds: 2e-12 },
            ] },
          } }],
        }] } },
      },
    });
  });

  it("rejects changed payloads and IDs instead of editing a replacement", () => {
    const { drafts, relax, scene } = fixture();
    relax.payload.max_steps = "200";
    expect(() => buildStudyPipelineStageMergePatch({ ...drafts[0], maxSteps: "60" }, 13, scene))
      .toThrow(/changed/);
    expect(() => buildStudyPipelineStageMergePatch({ ...drafts[0], stageId: "run-c" }, 13, scene))
      .toThrow(/identity/);
  });

  it("retains an explicit zero in the advanced adaptive policy", () => {
    const { relax, scene } = fixture();
    Object.assign(relax.payload, {
      solver: "rk23", fixed_timestep: "",
      adaptive_timestep: {
        tolerance_mode: "advanced", atol: 1e-6, rtol: 1e-3,
        dt_min: 1e-16, dt_max: 1e-13, safety: 0.9, growth_limit: 2, shrink_limit: 0.2,
      },
    });
    const [draft] = createPipelineStudyStageDrafts(readStudyStageSource(scene.study).entries);
    const patch = buildStudyPipelineStageMergePatch({ ...draft, atol: "0" }, 12, scene);
    expect(patch).toMatchObject({ merge_patch: { study: { study_pipeline: { nodes: [{
      children: [{ payload: { adaptive_timestep: { atol: 0, rtol: 1e-3 } } }, expect.anything()],
    }] } } } });
  });

  it("edits a script Relax with a backend-supported legacy integrator alias", () => {
    const { pipeline, group, relax, run, scene } = fixture();
    Object.assign(relax.payload, {
      solver: " BS23 ", fixed_timestep: "", dt: "AUTO",
      max_error: 1e-4, dt_min: 1e-16, dt_max: 1e-13,
    });
    const [draft] = createPipelineStudyStageDrafts(readStudyStageSource(scene.study).entries);
    expect(draft).toMatchObject({ solver: "rk23", timestepMode: "adaptive", maxError: "0.0001" });
    const { dt: _dt, max_error: _error, dt_min: _min, dt_max: _max, fixed_timestep: _fixed, ...retained } =
      relax.payload as typeof relax.payload & { dt: string; max_error: number; dt_min: number; dt_max: number };
    const patch = buildStudyPipelineStageMergePatch({ ...draft, maxError: "1e-5" }, 12, scene);
    expect(patch).toEqual({
      kind: "merge_patch", base_revision: 12, merge_patch: {
        study: { study_pipeline: { ...pipeline, nodes: [{
          ...group, children: [{ ...relax, payload: { ...retained, adaptive_timestep: {
            tolerance_mode: "max_error", atol: 1e-5, rtol: 0, dt_min: 1e-16, dt_max: 1e-13,
          } } }, run],
        }] } },
      },
    });
  });

  it("shows the legacy fixed dt when the canonical field is empty and keeps it on unrelated edits", () => {
    const { relax, scene } = fixture();
    Object.assign(relax.payload, { fixed_timestep: " ", dt: "2e-15" });
    const [draft] = createPipelineStudyStageDrafts(readStudyStageSource(scene.study).entries);
    expect(draft).toMatchObject({ solver: "rk4", timestepMode: "fixed", dt: "2e-15" });
    const patch = buildStudyPipelineStageMergePatch({ ...draft, maxSteps: "70" }, 12, scene);
    expect(patch).toMatchObject({ merge_patch: { study: { study_pipeline: { nodes: [{
      children: [{ payload: { ...relax.payload, max_steps: "70" } }, expect.anything()],
    }] } } } });
  });

  it("keeps legacy adaptive controls when changing a stop condition", () => {
    const { relax, scene } = fixture();
    Object.assign(relax.payload, { solver: "rk23", fixed_timestep: "", max_err: 0.0001, dt_min: 1e-16, dt_max: 1e-13 });
    const [draft] = createPipelineStudyStageDrafts(readStudyStageSource(scene.study).entries);
    expect(draft).toMatchObject({ timestepMode: "adaptive", toleranceMode: "max_error", maxError: "0.0001" });
    const patch = buildStudyPipelineStageMergePatch({ ...draft, maxSteps: "60" }, 12, scene);
    expect(patch).toMatchObject({ merge_patch: { study: { study_pipeline: { nodes: [{
      children: [{ payload: { ...relax.payload, max_steps: "60" } }, expect.anything()],
    }] } } } });
  });
});
