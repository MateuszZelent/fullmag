import { describe, expect, it } from "vitest";

import type { LiveStatusResource } from "../api/apiTypes";

import { resolveSessionStatusRevision } from "./useSessionStatus";

const resources: LiveStatusResource["resources"] = {
  artifact_revision: 0,
  artifacts_revision: 0,
  command_completion_revision: 0,
  commands_revision: 0,
  display_revision: 0,
  domain_generation_id: 0,
  engine_log_revision: 0,
  field_catalog_revision: 0,
  field_revision: 0,
  fields_revision: 0,
  mesh_build_revision: 0,
  mesh_revision: 0,
  scalars_revision: 0,
  scene_revision: null,
  slice_revision: 0,
  stages_revision: 0,
  topology_revision: 0,
  visualization_state_revision: 0,
  workspace_revision: 0,
};

describe("resolveSessionStatusRevision", () => {
  it("uses the generated LiveStatus resource revision map", () => {
    const status = {
      resources: {
        ...resources,
        command_completion_revision: 4,
        fields_revision: 9,
        workspace_revision: 3,
      },
    } as LiveStatusResource;

    expect(resolveSessionStatusRevision(status)).toBe(9);
  });
});
