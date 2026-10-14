import { describe, expect, it } from "vitest";

import { selectionRefFromNode } from "../../explorerSelection";
import { modelTreeSnapshotFromScene } from "../sceneModelTreeAdapter";
import { buildStudyNodes } from "./studyExplorerNodes";

describe("antenna field-solve Study node", () => {
  it("routes the outer stage identity without replacing it with the definition reference", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [],
      study: {
        stages: [{
          id: "solve-queue-entry",
          kind: "antenna_field_solve",
          payload: {
            entrypoint_kind: "flat_antenna_field_solve",
            port_mode_ids: ["authored-port"],
            stage_id: "authored-definition",
          },
        }],
      },
    });
    const node = buildStudyNodes(snapshot.study).children?.[0]?.children?.[0];

    expect(node).toMatchObject({
      badge: "field solve",
      icon: "wave",
      id: "model:study:stages:stage:solve-queue-entry",
      kind: "study.stage.antenna_field_solve",
      label: "Antenna Field Solve 1",
      stageId: "solve-queue-entry",
      stageIndex: 0,
    });
    expect(selectionRefFromNode(node!)).toEqual({
      kind: "study.stage.antenna_field_solve",
      nodeId: "model:study:stages:stage:solve-queue-entry",
      stageId: "solve-queue-entry",
      stageIndex: 0,
      type: "study-stage",
    });
  });

  it("preserves runtime completion without presenting it as physical qualification", () => {
    const node = buildStudyNodes({ stages: [{
      index: 2,
      kind: "ANTENNA_FIELD_SOLVE",
      stageId: "inspection",
      status: "completed",
    }] }).children?.[0]?.children?.[0];

    expect(node).toMatchObject({
      badge: "field solve",
      label: "Antenna Field Solve 3",
      status: "completed",
    });
    expect(node).not.toHaveProperty("antennaResourceId");
    expect(node).not.toHaveProperty("objectId");
    expect(node).not.toHaveProperty("availability");
  });
});
