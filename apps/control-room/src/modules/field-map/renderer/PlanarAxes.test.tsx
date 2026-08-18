import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PlanarAxisFrame } from "../model/planarAxisModel";
import { PlanarAxes } from "./PlanarAxes";

const cases: readonly [
  string,
  PlanarAxisFrame,
  readonly [string, string],
][] = [
  [
    "xy",
    { normal: [0, 0, 1], origin: [1e-6, 2e-6, 3e-6], uAxis: [1, 0, 0], vAxis: [0, 1, 0] },
    ["x", "y"],
  ],
  [
    "xz",
    { normal: [0, -1, 0], origin: [1e-6, 2e-6, 3e-6], uAxis: [1, 0, 0], vAxis: [0, 0, 1] },
    ["x", "z"],
  ],
  [
    "yz",
    { normal: [1, 0, 0], origin: [1e-6, 2e-6, 3e-6], uAxis: [0, 1, 0], vAxis: [0, 0, 1] },
    ["y", "z"],
  ],
  [
    "oblique",
    {
      normal: [0, 0, 1],
      origin: [1e-6, 2e-6, 3e-6],
      uAxis: [Math.SQRT1_2, Math.SQRT1_2, 0],
      vAxis: [-Math.SQRT1_2, Math.SQRT1_2, 0],
    },
    ["x′", "y′"],
  ],
];

describe("PlanarAxes", () => {
  it.each(cases)("renders %s labels, a shared unit, and bounded scientific ticks", (preset, frame, labels) => {
    const html = renderToStaticMarkup(
      <PlanarAxes
        bounds={[-4e-6, 6e-6, -2e-6, 3e-6]}
        frame={frame}
        plotSize={{ height: 320, width: 640 }}
        viewport={[-2e-6, 3e-6, -1e-6, 1.5e-6]}
      />,
    );

    expect(html).toContain(`data-planar-axis-preset="${preset}"`);
    expect(html).toContain(`aria-label="Horizontal ${labels[0]} axis"`);
    expect(html).toContain(`aria-label="Vertical ${labels[1]} axis"`);
    expect(html).toContain(`>${labels[0]} (µm)<`);
    expect(html).toContain(`>${labels[1]} (µm)<`);
    expect(html.match(/data-planar-axis-tick=/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain("u (");
    expect(html).not.toContain("v (");
  });
});
