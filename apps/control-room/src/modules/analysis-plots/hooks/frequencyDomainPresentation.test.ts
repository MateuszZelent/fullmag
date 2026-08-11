import { describe, expect, it } from "vitest";

import { deriveFrequencyDomainPresentationState } from "./useAnalysisFrequencyData";

describe("frequency-domain presentation projection", () => {
  it("retains the visible revision while a newer artifact refreshes", () => {
    expect(deriveFrequencyDomainPresentationState({
      data: { artifact_path: "spectrum.json" },
      error: null,
      revision: 41,
      status: "stale",
    }, "stale", null)).toEqual({
      kind: "refreshing",
      requestedRevision: 41,
      visibleRevision: 41,
    });
  });

  it("shows a retained chart as stale when refresh fails", () => {
    expect(deriveFrequencyDomainPresentationState({
      data: { artifact_path: "spectrum.json" },
      error: new Error("network"),
      revision: 41,
      status: "error",
    }, "error", null)).toMatchObject({
      kind: "stale",
      visibleRevision: 41,
    });
  });

  it("keeps an unsupported route distinct from an empty resource", () => {
    expect(deriveFrequencyDomainPresentationState({
      data: null,
      error: null,
      revision: null,
      status: "ready",
    }, "unsupported", "The selected artifact has no response sweep.")).toEqual({
      kind: "unsupported",
      reason: "The selected artifact has no response sweep.",
    });
  });

  it("uses initial loading only when no frequency payload is retained", () => {
    expect(deriveFrequencyDomainPresentationState({
      data: null,
      error: null,
      revision: null,
      status: "loading",
    }, "loading", null)).toEqual({ kind: "initial-loading" });
  });
});
