import { describe, expect, it } from "vitest";

import { buildFemLiveRenderDebugData } from "../femLiveRenderDebugData";

describe("buildFemLiveRenderDebugData", () => {
  it("returns null outside FEM discretization", () => {
    expect(
      buildFemLiveRenderDebugData({
        femDiscretization: false,
        viewMode: "3D",
        fieldLabel: "m",
        selectedVectorSourceKind: "live",
        effectiveStep: 1,
        liveFieldSourceStep: 1,
        previewSourceStep: null,
        fieldData: null,
        meshFieldRevision: null,
        dataFieldRevision: 1,
        fieldDataTimestamp: 100,
        viewportUpdateClass: "field_revision_changed",
      }),
    ).toBeNull();
  });

  it("prefers mesh field revision and live source step for live transport", () => {
    expect(
      buildFemLiveRenderDebugData({
        femDiscretization: true,
        viewMode: "3D",
        fieldLabel: "Magnetization",
        selectedVectorSourceKind: "live",
        effectiveStep: 3,
        liveFieldSourceStep: 3,
        previewSourceStep: 2,
        fieldData: null,
        meshFieldRevision: "mesh-field:7",
        dataFieldRevision: "data-field:8",
        fieldDataTimestamp: 123,
        viewportUpdateClass: "field_revision_changed",
      }),
    ).toMatchObject({
      backendLabel: "fem",
      fieldLabel: "Magnetization",
      transportLabel: "live",
      bufferSourceStep: 3,
      fieldRevision: "mesh-field:7",
      fieldDataTimestamp: 123,
      viewportUpdateClass: "field_revision_changed",
    });
  });

  it("uses preview source step for preview transport", () => {
    expect(
      buildFemLiveRenderDebugData({
        femDiscretization: true,
        viewMode: "3D",
        fieldLabel: "m",
        selectedVectorSourceKind: "preview",
        effectiveStep: 4,
        liveFieldSourceStep: 5,
        previewSourceStep: 2,
        fieldData: null,
        meshFieldRevision: null,
        dataFieldRevision: "data-field:8",
        fieldDataTimestamp: null,
        viewportUpdateClass: "presentation_changed",
      })?.bufferSourceStep,
    ).toBe(2);
  });
});
