import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PlanarFieldMetaResource } from "@/kernel/api/apiTypes";

import { PlanarSectionStrip } from "./PlanarSectionStrip";

const fdmSection = {
  cut_element_count: null,
  layer_count: 4,
  layer_index: 1,
  layer_spacing_m: 1e-9,
  layer_stops_m: [],
  navigation_step_kind: "fdm_cell",
  navigation_step_m: 1e-9,
  normal_axis: "z",
  normal_max_m: 4e-9,
  normal_min_m: 0,
  plane: "xy",
  requested_coordinate_m: 1.5e-9,
  requested_fraction: 0.5,
  resolved_coordinate_m: 1.5e-9,
  stops_kind: "fdm_cell_layers",
} as unknown as NonNullable<PlanarFieldMetaResource["section"]>;

const femSection = {
  cut_element_count: 8,
  layer_count: null,
  layer_index: null,
  layer_spacing_m: null,
  layer_stops_m: [],
  navigation_step_kind: "extent_fraction",
  navigation_step_m: 1e-11,
  normal_axis: "z",
  normal_max_m: 10e-9,
  normal_min_m: 0,
  plane: "xy",
  requested_coordinate_m: 2.5e-9,
  requested_fraction: 0.25,
  resolved_coordinate_m: 2.5e-9,
  stops_kind: "continuous",
} as unknown as NonNullable<PlanarFieldMetaResource["section"]>;

const averageOperator = { kind: "slab_average", thickness_m: 8e-9 } as const;

function render(
  section: NonNullable<PlanarFieldMetaResource["section"]>,
  operator: { kind: "plane_sample" } | { kind: "slab_average"; thickness_m: number },
  positionFraction = 0.5,
) {
  return renderToStaticMarkup(
    <PlanarSectionStrip
      defaultSlice={{ operator, plane: "xy", position_fraction: positionFraction }}
      section={section}
      onChange={() => undefined}
    />,
  );
}

describe("PlanarSectionStrip", () => {
  it("offers a discrete FDM layer slider with the snapped coordinate", () => {
    const html = render(fdmSection, { kind: "plane_sample" });
    expect(html).toContain('aria-label="Section plane"');
    expect(html).toContain('aria-label="Layer along z"');
    expect(html).toContain('max="3"');
    expect(html).toContain('value="1"');
    expect(html).toContain("z: 1.50 nm · layer 1 / 3");
  });

  it("describes the full-thickness average instead of a slider", () => {
    const html = render(fdmSection, averageOperator);
    expect(html).toContain("Mean over Z · 4 layers");
    expect(html).not.toContain('type="range"');
  });

  it("keeps a continuous position for unstructured meshes", () => {
    const html = render(femSection, { kind: "plane_sample" }, 0.25);
    expect(html).toContain('aria-label="Position along z"');
    expect(html).toContain("z: 2.50 nm");
    expect(html).not.toContain("· layer");
  });

  it("uses the published Airbox bounds and FDM layer count", () => {
    const airbox = {
      ...fdmSection,
      layer_count: 26,
      layer_spacing_m: 2.5e-9,
      normal_max_m: 60e-9,
      normal_min_m: -5e-9,
      resolved_coordinate_m: 26.25e-9,
    } as NonNullable<PlanarFieldMetaResource["section"]>;
    const html = render(airbox, { kind: "plane_sample" });

    expect(html).toContain('max="25"');
    expect(html).toContain("z: 26.3 nm · layer 12 / 25");
  });
});
