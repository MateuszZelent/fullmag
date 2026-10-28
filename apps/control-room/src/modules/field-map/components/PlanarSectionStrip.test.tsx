import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DomainMetaResource } from "@/kernel/api/apiTypes";

import { PlanarSectionStrip } from "./PlanarSectionStrip";

const fdmDomain = {
  bounds: { min: [0, 0, 0], max: [512e-9, 256e-9, 4e-9] },
  discretization: "fdm",
  grid: { origin: [0, 0, 0], shape: [128, 64, 4], spacing: [4e-9, 4e-9, 1e-9] },
} as unknown as DomainMetaResource;

const femDomain = {
  bounds: { min: [0, 0, 0], max: [100e-9, 50e-9, 10e-9] },
  discretization: "fem",
  grid: null,
} as unknown as DomainMetaResource;

function render(
  domain: DomainMetaResource,
  operator: { kind: "plane_sample" } | { kind: "slab_average"; thickness_m: number },
  positionFraction = 0.5,
) {
  return renderToStaticMarkup(
    <PlanarSectionStrip
      defaultSlice={{ operator, plane: "xy", position_fraction: positionFraction }}
      domain={domain}
      onChange={() => undefined}
    />,
  );
}

describe("PlanarSectionStrip", () => {
  it("offers a discrete FDM layer slider with the snapped coordinate", () => {
    const html = render(fdmDomain, { kind: "plane_sample" });
    expect(html).toContain('aria-label="Section plane"');
    expect(html).toContain('aria-label="Layer along z"');
    expect(html).toContain('max="3"');
    expect(html).toContain('value="1"');
    expect(html).toContain("z: 1.50 nm · layer 1 / 3");
  });

  it("describes the full-thickness average instead of a slider", () => {
    const html = render(fdmDomain, { kind: "slab_average", thickness_m: 8e-9 });
    expect(html).toContain("Mean over Z · 4 layers");
    expect(html).not.toContain('type="range"');
  });

  it("keeps a continuous position for unstructured meshes", () => {
    const html = render(femDomain, { kind: "plane_sample" }, 0.25);
    expect(html).toContain('aria-label="Position along z"');
    expect(html).toContain("z: 2.50 nm");
    expect(html).not.toContain("· layer");
  });
});
