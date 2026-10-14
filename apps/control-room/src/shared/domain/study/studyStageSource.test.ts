import { describe, expect, it } from "vitest";

import { readStudyStageSource } from "./studyStageSource";

describe("executable study source projection", () => {
  const payload = { kind: "antenna_field_solve", stage_id: "definition", port_mode_ids: ["feed"] };
  const antenna = { id: "queue", label: "Antenna", node_kind: "primitive", stage_kind: "antenna_field_solve", payload };

  it("keeps queue identity outside the unchanged definition payload", () => {
    const source = readStudyStageSource({ study_pipeline: { version: "study_pipeline.v1", nodes: [antenna] } });
    expect(source.entries[0]).toMatchObject({ queueId: "queue", payload, enabled: true });
    expect(source.entries[0].payload).toBe(payload);
    expect(Object.keys(payload)).toEqual(["kind", "stage_id", "port_mode_ids"]);
  });

  it("retains disabled descendants, order and macro config without expansion", () => {
    const source = readStudyStageSource({ study_pipeline: { version: "study_pipeline.v1", nodes: [{
      id: "group", node_kind: "group", enabled: false, collapsed: true,
      children: [antenna, { id: "macro", node_kind: "macro", macro_kind: "hysteresis", config: { preserve: true } }],
    }] } });
    expect(source.entries.map((entry) => [entry.queueId, entry.enabled, entry.groupIds])).toEqual([
      ["queue", false, ["group"]], ["macro", false, ["group"]],
    ]);
    expect(source.entries[1].payload).toEqual({ preserve: true });
    expect(source.entries[1].stageKind).toBe("macro:hysteresis");
  });

  it("does not revive dormant stages for an empty or unsupported pipeline", () => {
    for (const document of [{}, { version: "study_pipeline.v1" }, { nodes: [] }]) {
      expect(readStudyStageSource({ stages: [payload], study_pipeline: document }))
        .toEqual({ kind: "pipeline", entries: [], error: null });
    }
    expect(readStudyStageSource({ stages: [payload], study_pipeline: { version: "study_pipeline.v1", nodes: [] } }))
      .toEqual({ kind: "pipeline", entries: [], error: null });
    expect(readStudyStageSource({ stages: [payload], study_pipeline: { version: "future", nodes: [] } }).kind).toBe("invalid");
    for (const document of [{ version: null }, { nodes: null }]) {
      expect(readStudyStageSource({ stages: [payload], study_pipeline: document }).kind).toBe("invalid");
    }
  });

  it("rejects duplicate IDs, including between groups and leaves", () => {
    const source = readStudyStageSource({ study_pipeline: { version: "study_pipeline.v1", nodes: [
      antenna, { id: "queue", node_kind: "group", children: [] },
    ] } });
    expect(source.kind).toBe("invalid");
    expect(source.entries).toEqual([]);
  });

  it("uses the flat list only when no canonical document exists", () => {
    expect(readStudyStageSource({ stages: [payload] }).entries[0].queueId).toBeNull();
  });

  it("honors omitted map/vector defaults but rejects explicit null and invalid enabled", () => {
    const defaults = readStudyStageSource({ study_pipeline: { version: "study_pipeline.v1", nodes: [
      { id: "empty-group", node_kind: "group" },
      { id: "empty-payload", node_kind: "primitive", stage_kind: "save_state" },
    ] } });
    expect(defaults.kind).toBe("pipeline");
    expect(defaults.entries[0].payload).toEqual({});
    for (const node of [{ ...antenna, payload: null }, { ...antenna, enabled: "false" },
      { id: "group", node_kind: "group", children: null }]) {
      expect(readStudyStageSource({ study_pipeline: { version: "study_pipeline.v1", nodes: [node] } }).kind).toBe("invalid");
    }
  });
});
