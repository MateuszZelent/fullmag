import { describe, expect, it } from "vitest";

import { buildActionStageNode } from "./actionStageNode";

describe("buildActionStageNode", () => {
  it("labels mask antenna stage actions as in the exported script and routes them to study.stage.mask_field_drive", () => {
    const addNode = buildActionStageNode({ index: 0, kind: "add_mask_field_drive" });
    const updateNode = buildActionStageNode({ index: 2, kind: "update_mask_field_drive" });

    expect(addNode.label).toBe("Add Antenna 1");
    expect(addNode.kind).toBe("study.stage.mask_field_drive");
    expect(updateNode.label).toBe("Update Antenna 3");
    expect(updateNode.kind).toBe("study.stage.mask_field_drive");
  });

  it("keeps the generic label and the action selection kind for other actions", () => {
    const node = buildActionStageNode({ index: 1, kind: "remove_field_drive" });

    expect(node.label).toBe("Remove Field Drive 2");
    expect(node.kind).toBe("study.stage.action");
  });
});
