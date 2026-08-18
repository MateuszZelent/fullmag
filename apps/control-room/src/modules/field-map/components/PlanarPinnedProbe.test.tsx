import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { resolvePlanarAxes, resolvePlanarProbeCoordinates } from "../model/planarAxisModel";
import { PlanarPinnedProbe } from "./PlanarPinnedProbe";

describe("PlanarPinnedProbe", () => {
  it("renders Cartesian world coordinates and the converted scalar value", () => {
    const frame = {
      normal: [0, 0, 1] as const,
      origin: [11, 22, 32] as const,
      uAxis: [1, 0, 0] as const,
      vAxis: [0, 1, 0] as const,
    };
    const html = renderToStaticMarkup(
      <PlanarPinnedProbe
        axisState={{
          axes: resolvePlanarAxes(frame, [0, 1, 0, 1], [0, 1, 0, 1], 1, 1),
          coordinates: resolvePlanarProbeCoordinates(frame, 2, 3),
        }}
        legendUnit="kA/m"
        probe={{ occupancy: "occupied", scalar: 1_000, u_m: 2, v_m: 3 }}
        probeScale={1e-3}
      />,
    );

    expect(html).toContain("Pinned planar probe");
    expect(html).toContain('<th scope="row">x</th><td>13 m</td>');
    expect(html).toContain('<th scope="row">y</th><td>25 m</td>');
    expect(html).toContain('<th scope="row">Value</th><td>1 kA/m</td>');
    expect(html).not.toContain('<th scope="row">u</th>');
    expect(html).not.toContain('<th scope="row">v</th>');
  });
});
