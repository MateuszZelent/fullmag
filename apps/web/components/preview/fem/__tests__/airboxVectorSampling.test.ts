import { describe, expect, it } from "vitest";

import { resolveAirboxArrowSamplingMode } from "../airboxVectorSampling";

describe("resolveAirboxArrowSamplingMode", () => {
  it("keeps the selected sampling mode outside airbox-only vectors", () => {
    expect(
      resolveAirboxArrowSamplingMode({
        resolvedVectorDomain: "full_domain",
        arrowSamplingMode: "volume",
        visibleLayers: [
          { part: { role: "air" }, viewState: { vectorsScope: "surface" } },
        ],
      }),
    ).toBe("volume");
  });

  it("defaults airbox-only vectors to surface sampling without an air layer", () => {
    expect(
      resolveAirboxArrowSamplingMode({
        resolvedVectorDomain: "airbox_only",
        arrowSamplingMode: "volume",
        visibleLayers: [],
      }),
    ).toBe("surface");
  });

  it("uses surface vector sampling independently from full points", () => {
    const layerWithFullPoints = {
      part: { role: "air" },
      viewState: { vectorsScope: "surface", pointsScope: "full" },
    } as const;

    expect(
      resolveAirboxArrowSamplingMode({
        resolvedVectorDomain: "airbox_only",
        arrowSamplingMode: "volume",
        visibleLayers: [layerWithFullPoints],
      }),
    ).toBe("surface");
  });

  it("uses volume vector sampling independently from surface points", () => {
    const layerWithSurfacePoints = {
      part: { role: "outer_boundary" },
      viewState: { vectorsScope: "full", pointsScope: "surface" },
    } as const;

    expect(
      resolveAirboxArrowSamplingMode({
        resolvedVectorDomain: "airbox_only",
        arrowSamplingMode: "surface",
        visibleLayers: [layerWithSurfacePoints],
      }),
    ).toBe("volume");
  });
});
