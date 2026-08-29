import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { LiveStatusResource } from "@/kernel/api/apiTypes";
import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { buildRuntimeCommandControlResourceData } from "@/kernel/resources/studyRuntimeResources";
import { STUDY_RUNTIME_COMMANDS } from "@/kernel/runtime/studyRuntimeCommandContributions";

import { __ribbonModuleTestUtils } from "./RibbonModule";

const baseResources: LiveStatusResource["resources"] = {
  artifact_revision: 0,
  artifacts_revision: 0,
  command_completion_revision: 0,
  commands_revision: 4,
  display_revision: 0,
  domain_generation_id: "1",
  engine_log_revision: 0,
  field_catalog_revision: 0,
  field_revision: 0,
  fields_revision: 0,
  mesh_build_revision: 0,
  mesh_revision: 0,
  mode_composition_revision: 0,
  region_coefficients_revision: 0,
  region_initial_state_revision: 0,
  region_membership_revision: 0,
  region_topology_revision: 0,
  scalars_revision: 0,
  scene_revision: 1,
  simulation_preparation_revision: 0,
  slice_revision: 0,
  solver_profile_revision: 0,
  stages_revision: 2,
  topology_revision: 0,
  visualization_state_revision: 0,
  workspace_revision: 0,
};

function statusWith({
  runId = "run-1",
  sessionId = "session-1",
}: {
  runId?: string | null;
  sessionId?: string;
} = {}): LiveStatusResource {
  return {
    capabilities: {
      algorithms_available: [],
      binary_fields: true,
      cell_fields: true,
      eigen_modes: false,
      explicit_topology: false,
      gpu_telemetry: true,
      node_fields: false,
      preview_2d: true,
      preview_3d: true,
      scalar_history: true,
      structured_grid: true,
    },
    domain: {
      cell_count: 1,
      discretization: "fdm",
      generation_id: "1",
    },
    resources: baseResources,
    run: runId
      ? {
          run_id: runId,
          solver_steps: 0,
          solver_time: 0,
          stage_count: 1,
          stage_index: 0,
          stage_label: "relax",
          started_at: "2026-05-31T00:00:00.000Z",
        }
      : null,
    session: {
      created_at: "2026-05-31T00:00:00.000Z",
      name: "Runtime status test",
      session_id: sessionId,
      workspace_root: "/tmp/fullmag-runtime-status-test",
    },
  } as unknown as LiveStatusResource;
}

function select(status: LiveStatusResource) {
  return __ribbonModuleTestUtils.selectRibbonRuntimeStatus({ data: status });
}

describe("RibbonModule runtime status selection", () => {
  it("wires the runtime field catalog into ribbon tab construction", () => {
    const source = readFileSync(new URL("./RibbonModule.tsx", import.meta.url), "utf8");

    expect(source).toContain("useFieldCatalogResource({");
    expect(source).toContain("fieldCatalog: fieldCatalog.data,");
    expect(source).toContain("useModelReadinessResource({");
    expect(source).toContain("buildRuntimeCommandControlResourceData({");
  });

  it.each([
    {
      enabled: true,
      name: "ready",
      readiness: { blockers: [], ready_to_run: true, scene_revision: 1 },
      reason: null,
    },
    {
      enabled: false,
      name: "blocked",
      readiness: {
        blockers: ["Assign a material to every magnetic object."],
        ready_to_run: false,
        scene_revision: 1,
      },
      reason: "Assign a material to every magnetic object.",
    },
    {
      enabled: false,
      name: "stale",
      readiness: { blockers: [], ready_to_run: true, scene_revision: 0 },
      reason: "Model readiness is stale for the current scene.",
    },
  ])("feeds $name readiness into the Ribbon Run command", ({ enabled, readiness, reason }) => {
    const commands = new CommandRegistry();
    for (const command of STUDY_RUNTIME_COMMANDS) commands.register(command);
    const resourceData = buildRuntimeCommandControlResourceData({
      commandQueue: { commands: [] },
      geometryValidation: { diagnostics: [] },
      meshBuildCurrent: null,
      meshManifest: null,
      modelReadinessData: {
        capabilities: {} as never,
        checks: [],
        ready_to_export: readiness.ready_to_run,
        ...readiness,
      },
      modelReadinessStatus: "ready",
      sessionStatus: statusWith(),
      solverStatus: { runtime_state: "idle" },
      stageExecution: {
        active_stage_index: null,
        revision: 1,
        runtime_state: "idle",
        stages: [],
      },
    });
    const context = { api: {} as never, resourceData, source: "ribbon" as const };

    expect(commands.isEnabled("study.run", context)).toBe(enabled);
    expect(commands.get("study.run")?.disabledReason?.(context)).toBe(reason);
  });
  it("treats session identity changes as runtime command state changes", () => {
    const previous = select(statusWith({ sessionId: "session-old" }));
    const next = select(statusWith({ sessionId: "session-new" }));

    expect(
      __ribbonModuleTestUtils.ribbonRuntimeStatusEquals(previous, next),
    ).toBe(false);
  });

  it("treats run identity changes as runtime command state changes", () => {
    const previous = select(statusWith({ runId: "run-old" }));
    const next = select(statusWith({ runId: "run-new" }));

    expect(
      __ribbonModuleTestUtils.ribbonRuntimeStatusEquals(previous, next),
    ).toBe(false);
  });

  it("treats command completion revision changes as runtime command state changes", () => {
    const previous = select({
      ...statusWith(),
      resources: {
        ...baseResources,
        command_completion_revision: 3,
        commands_revision: 4,
      },
    });
    const next = select({
      ...statusWith(),
      resources: {
        ...baseResources,
        command_completion_revision: 4,
        commands_revision: 4,
      },
    });

    expect(
      __ribbonModuleTestUtils.ribbonRuntimeStatusEquals(previous, next),
    ).toBe(false);
  });
});
