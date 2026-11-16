import { describe, expect, it } from "vitest";

import { buildActionStageNode } from "./actionStageNode";

describe("buildActionStageNode", () => {
  it("labels the stage actions of a mask antenna as in the exported script", () => {
    expect(buildActionStageNode({ index: 0, kind: "add_mask_field_drive" }).label).toBe("Add Antenna 1");
    expect(buildActionStageNode({ index: 2, kind: "update_mask_field_drive" }).label).toBe("Update Antenna 3");
  });

  it("keeps the generic label and the action selection kind for other actions", () => {
    const node = buildActionStageNode({ index: 1, kind: "remove_field_drive" });

    expect(node.label).toBe("Remove Field Drive 2");
    expect(node.kind).toBe("study.stage.action");
    expect(buildActionStageNode({ index: 0, kind: "add_mask_field_drive" }).kind).toBe("study.stage.action");
  });
});
