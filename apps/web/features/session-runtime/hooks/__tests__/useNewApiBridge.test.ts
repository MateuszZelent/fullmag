import { describe, expect, it } from "vitest";

import { buildLiveStatusRevisionKey } from "../useNewApiBridge";

describe("buildLiveStatusRevisionKey", () => {
  it("is stable for equivalent resource revisions without JSON stringifying the object", () => {
    const resources = {
      fields_revision: 2,
      scalars_revision: 3,
      domain_generation_id: 4,
      artifacts_revision: 5,
      engine_log_revision: 6,
      display_revision: 7,
      visualization_state_revision: 8,
      workspace_revision: 9,
      mesh_revision: 10,
      mesh_build_revision: 11,
      commands_revision: 12,
      stages_revision: 13,
    };

    expect(
      buildLiveStatusRevisionKey({
        sessionId: "session-a",
        runId: "run-a",
        resources,
      }),
    ).toBe(
      buildLiveStatusRevisionKey({
        sessionId: "session-a",
        runId: "run-a",
        resources: { ...resources },
      }),
    );
  });

  it("changes when a watched revision changes", () => {
    const base = {
      sessionId: "session-a",
      runId: "run-a",
      resources: {
        fields_revision: 2,
        scalars_revision: 3,
        domain_generation_id: 4,
        artifacts_revision: 5,
        engine_log_revision: 6,
        display_revision: 7,
        visualization_state_revision: 8,
        workspace_revision: 9,
        mesh_revision: 10,
        mesh_build_revision: 11,
        commands_revision: 12,
        stages_revision: 13,
      },
    };

    expect(buildLiveStatusRevisionKey(base)).not.toBe(
      buildLiveStatusRevisionKey({
        ...base,
        resources: { ...base.resources, mesh_revision: 14 },
      }),
    );
  });
});
