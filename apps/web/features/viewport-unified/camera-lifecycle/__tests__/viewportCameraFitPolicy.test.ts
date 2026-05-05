import { describe, expect, it } from "vitest";

import { resolveViewportCameraFitDecision } from "../viewportCameraFitPolicy";

describe("resolveViewportCameraFitDecision", () => {
  it("advances camera fit generation on the first enabled fit seed", () => {
    expect(
      resolveViewportCameraFitDecision({
        enabled: true,
        persistedCameraAvailable: false,
        previousFitSignature: null,
        viewportFitSeed: "topology:1",
      }),
    ).toEqual({
      nextFitSignature: "topology:1",
      shouldAdvanceGeneration: true,
    });
  });

  it("does not advance generation for unchanged fit seed", () => {
    expect(
      resolveViewportCameraFitDecision({
        enabled: true,
        persistedCameraAvailable: false,
        previousFitSignature: "topology:1",
        viewportFitSeed: "topology:1",
      }),
    ).toEqual({
      nextFitSignature: "topology:1",
      shouldAdvanceGeneration: false,
    });
  });

  it("records topology seed changes without fitting over a persisted camera", () => {
    expect(
      resolveViewportCameraFitDecision({
        enabled: true,
        persistedCameraAvailable: true,
        previousFitSignature: "topology:1",
        viewportFitSeed: "topology:2",
      }),
    ).toEqual({
      nextFitSignature: "topology:2",
      shouldAdvanceGeneration: false,
    });
  });

  it("keeps disabled fit effects inert", () => {
    expect(
      resolveViewportCameraFitDecision({
        enabled: false,
        persistedCameraAvailable: false,
        previousFitSignature: "topology:1",
        viewportFitSeed: "topology:2",
      }),
    ).toEqual({
      nextFitSignature: "topology:1",
      shouldAdvanceGeneration: false,
    });
  });
});
