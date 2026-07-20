import { describe, expect, it } from "vitest";

import type { LiveStatusResource } from "../api/apiTypes";

import { resolveSessionStatusRevision } from "./useSessionStatus";

const resources: LiveStatusResource["resources"] = {
  artifact_revision: 0,
  artifacts_revision: 0,
  command_completion_revision: 0,
  commands_revision: 0,
  display_revision: 0,
  domain_generation_id: "0",
  engine_log_revision: 0,
  field_catalog_revision: 0,
  field_revision: 0,
  fields_revision: 0,
  mesh_build_revision: 0,
  mesh_revision: 0,
  region_coefficients_revision: 0,
  region_initial_state_revision: 0,
  region_membership_revision: 0,
  region_topology_revision: 0,
  scalars_revision: 0,
  scene_revision: null,
  simulation_preparation_revision: 0,
  slice_revision: 0,
  solver_profile_revision: 0,
  stages_revision: 0,
  topology_revision: 0,
  visualization_state_revision: 0,
  workspace_revision: 0,
};

describe("resolveSessionStatusRevision", () => {
  it("uses status-affecting resource revisions instead of result-data revisions", () => {
    const status = {
      resources: {
        ...resources,
        command_completion_revision: 4,
        field_catalog_revision: 90,
        field_revision: 80,
        fields_revision: 70,
        scalars_revision: 60,
        slice_revision: 50,
        topology_revision: 40,
        workspace_revision: 3,
      },
    } as LiveStatusResource;

    expect(resolveSessionStatusRevision(status)).toBe(4);
  });

  it("still tracks shell and runtime control revisions", () => {
    const status = {
      resources: {
        ...resources,
        commands_revision: 5,
        display_revision: 8,
        mesh_build_revision: 7,
        mesh_revision: 6,
        scene_revision: 9,
        solver_profile_revision: 11,
        stages_revision: 10,
        visualization_state_revision: 12,
        workspace_revision: 13,
      },
    } as LiveStatusResource;

    expect(resolveSessionStatusRevision(status)).toBe(13);
  });

  it("tracks simulation preparation revisions", () => {
    const status = {
      resources: {
        ...resources,
        simulation_preparation_revision: 14,
      },
    } as LiveStatusResource;

    expect(resolveSessionStatusRevision(status)).toBe(14);
  });

  it("tracks independent region realization revisions", () => {
    const status = {
      resources: {
        ...resources,
        region_topology_revision: 21,
        region_membership_revision: 22,
        region_coefficients_revision: 23,
        region_initial_state_revision: 24,
      },
    } as LiveStatusResource;

    expect(resolveSessionStatusRevision(status)).toBe(24);
  });
});
