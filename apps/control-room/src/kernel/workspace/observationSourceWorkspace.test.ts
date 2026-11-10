import { describe, expect, it } from "vitest";

import type { FieldMetaResource, ObservationFrameResource, PreparedInitialStateResource } from "../api/apiTypes";

import {
  observationSourceWorkspaceStore,
  pinnedObservationSourceFromFrame,
  resetObservationSourceWorkspaceForTests,
  resolvePreparedMagnetizationAvailability,
} from "./observationSourceWorkspace";

const FRAME = {
  accepted_state_ref: {
    generation: { accepted_revision: 7, runtime_epoch: 3 },
    id: {
      accepted_step: 42,
      clock_digest: "clock",
      domain_digest: "domain",
      plan_digest: "plan",
      run_id: "run-1",
      stage_id: "stage-1",
      state_digest: "state",
    },
  },
  adapter_id: "fdm.cpu.m.v1",
  attempt_id: "attempt-1",
  frame_id: "frame-1",
  grid_cells: [8, 4, 2],
  magnetization_href: "/magnetization",
  ownership_epoch: 5,
  quantity_ids: ["m"],
  run_id: "run-1",
  schema_version: "observation-frame.v1",
  stage_id: "stage-1",
  state_codec_id: "fdm-state",
  state_codec_version: "1",
  status: "complete",
  task_id: "task-1",
} satisfies ObservationFrameResource;

const SESSION = {
  requestScopeEpoch: "scope-1",
  sessionEpoch: "session-epoch-1",
  sessionId: "session-1",
};

describe("prepared magnetization availability", () => {
  const source: PreparedInitialStateResource = {
    scene_revision: 8, initial_state_revision: 3, publication_id: "publication-a",
    observation_frame_id: "frame-a", domain_generation_id: "domain-a",
    values_sha256: "b".repeat(64),
  };
  const live = { sceneRevision: 8, domainGenerationId: "domain-a" };
  const field = (frameId: string, publicationId = "publication-a") => ({
    domain_generation_id: "domain-a",
    observation_frame: { observation_frame_id: frameId },
    publication_bundle: { publication_id: publicationId },
  } as FieldMetaResource);

  it("requires current metadata before rendering a prepared preview", () => {
    const data = field("frame-a");
    expect(resolvePreparedMagnetizationAvailability(source, live, { data, status: "loading" })).toBe("checking");
    expect(resolvePreparedMagnetizationAvailability(source, { ...live, sceneRevision: 7 }, { data, status: "ready" })).toBe("checking");
    expect(resolvePreparedMagnetizationAvailability(source, live, { data, status: "ready" })).toBe("current");
  });

  it("rejects a new frame or publication on the same scene and domain", () => {
    expect(resolvePreparedMagnetizationAvailability(source, live, { data: field("frame-b"), status: "ready" })).toBe("superseded");
    expect(resolvePreparedMagnetizationAvailability(source, live, { data: field("frame-a", "publication-b"), status: "ready" })).toBe("superseded");
    expect(resolvePreparedMagnetizationAvailability(source, live, { data: null, status: "ready" })).toBe("superseded");
  });

  it("reports a superseding scene or changed domain even with cached metadata", () => {
    const meta = { data: field("frame-a"), status: "ready" } as const;
    expect(resolvePreparedMagnetizationAvailability(source, { ...live, sceneRevision: 9 }, meta)).toBe("superseded");
    expect(resolvePreparedMagnetizationAvailability(source, { ...live, domainGenerationId: "domain-b" }, meta)).toBe("earlier-domain");
  });
});

describe("observationSourceWorkspaceStore", () => {
  it("pins only the compact exact source identity", () => {
    resetObservationSourceWorkspaceForTests();
    observationSourceWorkspaceStore.pin(
      pinnedObservationSourceFromFrame(FRAME, SESSION),
    );

    expect(observationSourceWorkspaceStore.getSnapshot().pinned).toEqual({
      acceptedRevision: 7,
      acceptedStep: 42,
      adapterId: "fdm.cpu.m.v1",
      frameId: "frame-1",
      runId: "run-1",
      runtimeEpoch: 3,
      sessionIdentityKey: "session-1\u0000session-epoch-1\u0000scope-1",
      stageId: "stage-1",
      stateDigest: "state",
    });
  });

  it("switches from a pinned result to an exact prepared preview within one session", () => {
    resetObservationSourceWorkspaceForTests();
    const pinned = pinnedObservationSourceFromFrame(FRAME, SESSION);
    const preview = {
      objectId: "magnet",
      regionId: "core",
      sessionIdentityKey: pinned.sessionIdentityKey,
      source: {
        scene_revision: 8, initial_state_revision: 3, publication_id: "publication",
        observation_frame_id: "prepared-frame", domain_generation_id: "domain",
        values_sha256: "b".repeat(64),
      },
    };
    observationSourceWorkspaceStore.pin(pinned);
    observationSourceWorkspaceStore.showPrepared(preview);
    expect(observationSourceWorkspaceStore.getSnapshot()).toEqual({ pinned: null, prepared: preview });
    observationSourceWorkspaceStore.clearForSession(SESSION);
    expect(observationSourceWorkspaceStore.getSnapshot().prepared).toEqual(preview);
    observationSourceWorkspaceStore.clearForSession({ ...SESSION, requestScopeEpoch: "scope-2" });
    expect(observationSourceWorkspaceStore.getSnapshot().prepared).toBeNull();
  });

  it("clears a pin when the active session identity changes", () => {
    resetObservationSourceWorkspaceForTests();
    observationSourceWorkspaceStore.pin(
      pinnedObservationSourceFromFrame(FRAME, SESSION),
    );

    observationSourceWorkspaceStore.clearForSession({
      ...SESSION,
      requestScopeEpoch: "scope-2",
    });

    expect(observationSourceWorkspaceStore.getSnapshot().pinned).toBeNull();
  });
});
