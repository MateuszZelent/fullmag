import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";

import { FieldQuantityInspectorPanel } from "./FieldQuantityInspectorPanel";

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFieldMetaResource: ({ quantityId }: { quantityId: string }) => ({
    data: {
      components: 3,
      domain_generation_id: "mesh:42",
      field_revision: 7,
      kind: "vector",
      label: "Magnetization",
      location: "node",
      materialization_error: null,
      materialization_wall_time_ns: 1200,
      materialized_at_unix_ms: 1,
      quantity_id: quantityId,
      source_revision: 6,
      source_step: 5,
      stale_by_steps: 0,
      state: "complete",
      stats: { min: 1, mean: 2, max: 3 },
      unit: "A/m",
    },
    status: "ready",
  }),
}));

describe("FieldQuantityInspectorPanel", () => {
  it("uses the explorer quantity identity and renders scientific metadata", () => {
    const selection = {
      kind: "results.field_quantity",
      label: "Magnetization",
      moduleSource: "explorer",
      nodeId: "results:field:m",
      objectId: null,
      ref: null,
    } as Selection;

    const html = renderToStaticMarkup(
      <FieldQuantityInspectorPanel selection={selection} />,
    );

    expect(html).toContain("Field quantity");
    expect(html).toContain("Magnetization");
    expect(html).toContain("A/m");
    expect(html).toContain("mesh:42");
    expect(html).toContain("3.00000 A/m");
    expect(html).toContain('data-slot="inspector-overview-frame"');
  });
});
