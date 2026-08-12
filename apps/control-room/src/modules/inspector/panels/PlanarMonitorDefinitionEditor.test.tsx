import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  planarMonitorDraftFromMonitor,
  type PlanarMonitor,
} from "@/kernel/workspace/crossSectionWorkspace";

import {
  PlanarMonitorDefinitionEditor,
  planarMonitorDefinitionAvailabilityErrors,
  type PlanarMonitorDefinitionAvailability,
} from "./PlanarMonitorDefinitionEditor";

const monitor: PlanarMonitor = {
  id: "slab-1",
  name: "Slab",
  target: { kind: "object", object_id: "film" },
  frame: {
    origin_m: [1e-9, 2e-9, 3e-9],
    u_axis: [1, 0, 0],
    v_axis: [0, 1, 0],
    normal: [0, 0, 1],
    preset: null,
    normalization_version: "planar_frame_v1",
    extent: { kind: "target_bounds", padding_m: 2e-9 },
  },
  operator: { kind: "slab_average", thickness_m: 5e-9 },
};

describe("PlanarMonitorDefinitionEditor", () => {
  it("renders the full canonical monitor schema and slab-only thickness in display units", () => {
    const html = renderToStaticMarkup(
      <PlanarMonitorDefinitionEditor
        availability={{}}
        draft={planarMonitorDraftFromMonitor(monitor)}
        onChange={vi.fn()}
      />,
    );

    for (const section of ["Identity", "Target", "Frame", "Extent", "Operator"]) {
      expect(html).toContain(section);
    }
    expect(html).toContain('aria-label="Origin X"');
    expect(html).toContain('aria-label="Normal Z"');
    expect(html).toContain('aria-label="u axis X"');
    expect(html).toContain('aria-label="v axis Y"');
    expect(html).toContain('aria-label="Normalization version"');
    expect(html).toContain('aria-label="Slab thickness"');
    expect(html).toContain('value="5"');
    expect(html).toContain('value="nm" selected=""');
  });

  it("does not render thickness or retain slab parameters for plane_sample", () => {
    const draft = planarMonitorDraftFromMonitor({
      ...monitor,
      operator: { kind: "plane_sample" },
    });
    const html = renderToStaticMarkup(
      <PlanarMonitorDefinitionEditor availability={{}} draft={draft} onChange={vi.fn()} />,
    );
    expect(html).not.toContain('aria-label="Slab thickness"');
    expect(JSON.stringify(draft.monitor.operator)).not.toContain("thickness_m");
  });

  it("keeps unavailable target and operator choices visible, disabled and reasoned", () => {
    const availability: PlanarMonitorDefinitionAvailability = {
      operators: {
        surface_projection: { available: false, reason: "Boundary topology is unavailable." },
      },
      targets: {
        region: { available: false, reason: "Region membership is unavailable." },
      },
    };
    const html = renderToStaticMarkup(
      <PlanarMonitorDefinitionEditor
        availability={availability}
        draft={planarMonitorDraftFromMonitor(monitor)}
        onChange={vi.fn()}
      />,
    );
    expect(html).toContain('disabled="" value="region"');
    expect(html).toContain("Region membership is unavailable.");
    expect(html).toContain('disabled="" value="surface_projection"');
    expect(html).toContain("Boundary topology is unavailable.");
    expect(planarMonitorDefinitionAvailabilityErrors({
      ...monitor,
      operator: {
        kind: "surface_projection",
        boundary: { kind: "object_boundary" },
        visibility_policy: "frontmost",
      },
      target: { kind: "region", object_id: "film", region_id: "edge" },
    }, availability)).toEqual([
      "Region membership is unavailable.",
      "Boundary topology is unavailable.",
    ]);
  });
});
