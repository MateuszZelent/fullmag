import { describe, expect, it } from "vitest";

import { pinnedMaterializedDatasetSelectionRef } from "../selection/selectionTypes";
import { ObjectVisualizationController } from "./ObjectVisualizationController";

const first = pinnedMaterializedDatasetSelectionRef({
  projectId: "project", runId: "run", solutionSetId: "solution", containingRevision: "1",
  memberId: "member", artifactId: "artifact", manifestObjectRef: "manifest",
  sampleId: "sample", itemId: "item", fieldId: "H_ant", datasetId: "dataset", datasetRevision: "1",
});

describe("saved source geometry visibility", () => {
  it("hides only the context while preserving the field settings and selection", () => {
    const controller = new ObjectVisualizationController();
    controller.setSavedFieldPresentation(first, "H_ant", "3");
    const before = controller.getSnapshot().savedFieldPresentation!;
    expect(before.sourceGeometryVisible ?? true).toBe(true);

    controller.setSavedFieldSourceGeometryVisible(first, false);

    const hidden = controller.getSnapshot().savedFieldPresentation!;
    expect(hidden.sourceGeometryVisible).toBe(false);
    expect(hidden.settings).toBe(before.settings);
    expect(hidden.selection).toBe(before.selection);
    expect(hidden.colorRanges).toBe(before.colorRanges);
    controller.setSavedFieldSourceGeometryVisible(first, true);
    expect(controller.getSnapshot().savedFieldPresentation!.sourceGeometryVisible).toBe(true);
  });

  it("ignores stale selection handlers and repeated values", () => {
    const controller = new ObjectVisualizationController();
    controller.setSavedFieldPresentation(first, "H_ant", "3");
    controller.setSavedFieldSourceGeometryVisible(first, false);
    const second = pinnedMaterializedDatasetSelectionRef({ ...first, datasetId: "another-dataset" });
    controller.setSavedFieldPresentation(second, "H_ant", "3");
    const snapshot = controller.getSnapshot();

    controller.setSavedFieldSourceGeometryVisible(first, false);
    controller.setSavedFieldSourceGeometryVisible(second, true);

    expect(controller.getSnapshot()).toBe(snapshot);
    expect(snapshot.savedFieldPresentation!.sourceGeometryVisible ?? true).toBe(true);
  });
});
