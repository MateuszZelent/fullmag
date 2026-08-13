import { describe, expect, it } from "vitest";

import {
  fitPlanarInteraction,
  panPlanarInteraction,
  zoomPlanarInteractionAt,
} from "./planarInteraction";

describe("planar interaction", () => {
  const bounds = [0, 10, -5, 5] as const;

  it("zooms at the cursor without changing the physical cursor coordinate", () => {
    const next = zoomPlanarInteractionAt(bounds, { panU: 0, panV: 0, zoom: 1 }, 8, 2, 2);
    expect(next).toEqual({ panU: 1.5, panV: 1, zoom: 2 });
  });

  it("pans in physical monitor coordinates and fits exactly", () => {
    expect(panPlanarInteraction({ panU: 1, panV: -2, zoom: 4 }, -0.5, 0.25)).toEqual({
      panU: 0.5,
      panV: -1.75,
      zoom: 4,
    });
    expect(fitPlanarInteraction()).toEqual({ panU: 0, panV: 0, zoom: 1 });
  });
});
