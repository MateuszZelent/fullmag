import { describe, expect, it } from "vitest";

import { pinnedMaterializedDatasetSelectionRef } from "../selection/selectionTypes";
import { ObjectVisualizationController } from "./ObjectVisualizationController";

const first = pinnedMaterializedDatasetSelectionRef({
  projectId: "project", runId: "run", solutionSetId: "solution", containingRevision: "1",
  memberId: "member", artifactId: "artifact", manifestObjectRef: "manifest",
  sampleId: "sample", itemId: "item", fieldId: "H_ant", datasetId: "dataset", datasetRevision: "1",
});

describe("saved field section preferences", () => {
  it("keeps section controls with the pinned presentation across view remounts", () => {
    const controller = new ObjectVisualizationController();
    controller.setSavedFieldPresentation(first, "H_ant", "3");
    const before = controller.getSnapshot().savedFieldPresentation!;
    controller.patchSavedFieldSection(first, {
      plane: "xz", positionText: "0.05", component: "x", vectors: false,
      verticalExaggeration: 10, interaction: { panU: 0.1, panV: -0.2, zoom: 2 },
    });
    controller.setSavedFieldPresentation({ ...first }, "H_ant", "3");
    const after = controller.getSnapshot().savedFieldPresentation!;
    expect(after.section).toEqual({
      plane: "xz", positionText: "0.05", component: "x", vectors: false,
      verticalExaggeration: 10, interaction: { panU: 0.1, panV: -0.2, zoom: 2 },
    });
    expect(after.settings).toBe(before.settings);
    expect(after.selection).toBe(before.selection);
    controller.patchSavedFieldSection(first, { vectors: true });
    expect(controller.getSnapshot().savedFieldPresentation!.section).toEqual({
      ...after.section, vectors: true,
    });
  });

  it("does not copy section state to another dataset revision or accept stale controls", () => {
    const controller = new ObjectVisualizationController();
    controller.setSavedFieldPresentation(first, "H_ant", "3");
    controller.patchSavedFieldSection(first, { plane: "xz", positionText: "0.05" });
    const second = pinnedMaterializedDatasetSelectionRef({ ...first, datasetRevision: "2" });
    controller.setSavedFieldPresentation(second, "H_ant", "3");
    const snapshot = controller.getSnapshot();
    controller.patchSavedFieldSection(first, { plane: "xy" });
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(snapshot.savedFieldPresentation!.section).toBeUndefined();
    controller.clearSavedFieldPresentation();
    controller.patchSavedFieldSection(second, { vectors: false });
    expect(controller.getSnapshot().savedFieldPresentation).toBeNull();
  });

  it("does not invalidate resources for repeated section preferences", () => {
    const controller = new ObjectVisualizationController();
    controller.setSavedFieldPresentation(first, "H_ant", "3");
    controller.patchSavedFieldSection(first, { plane: "xz" });
    const snapshot = controller.getSnapshot();
    controller.patchSavedFieldSection(first, { plane: "xz" });
    expect(controller.getSnapshot()).toBe(snapshot);
  });
});
