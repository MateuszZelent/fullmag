import { describe, expect, it } from "vitest";

import type { FdmMultilayerLayoutResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

import { resolveFdmMultilayerInspectorModel } from "./fdmMultilayerInspectorModel";

const layout = {
  airbox: {
    carrier_available: true,
    carrier_fingerprint:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    cell_size_m: [2e-9, 3e-9, 4e-9],
    cells: [5, 4, 3],
    h_demag_available: true,
    h_eff_available: false,
    h_eff_unavailable_reason: "airbox_heff_not_available_v1",
    origin_m: [-4e-9, -6e-9, -8e-9],
    sample_count: 60,
    source_policy: "target_only",
    source_grid_fingerprints: ["sha256:native-a", "sha256:native-b"],
    target_only: true,
    value_count: 180,
  },
  available: true,
  backend: "fdm_multilayer",
  domain_generation_id: "generation-7",
  execution_revision: 3,
  layers: [],
  layout_revision: 5,
  observation_revision: 6,
  schema_version: "fdm-multilayer-layout.v1",
} satisfies FdmMultilayerLayoutResource;

const airboxSelection = {
  kind: "airbox.root",
  label: "Airbox",
  nodeId: "model:airbox",
  objectId: null,
  moduleSource: null,
  ref: {
    kind: "airbox.root",
    nodeId: "model:airbox",
    type: "airbox",
    visualizationTargetId: "airbox",
  },
} satisfies Selection;

describe("FDM multilayer Airbox inspector", () => {
  it("shows target-only carrier geometry and provenance without common-grid metadata", () => {
    const model = resolveFdmMultilayerInspectorModel(layout, airboxSelection);

    expect(model).toMatchObject({ title: "Multilayer Airbox", status: "ready" });
    expect(model?.rows).toEqual(
      expect.arrayContaining([
        { label: "Target-only", value: "yes" },
        { label: "H_demag", value: "available" },
        { label: "H_eff", value: "unavailable (airbox_heff_not_available_v1)" },
        { label: "Cells", value: "[5, 4, 3]" },
        { label: "Carrier fingerprint", value: layout.airbox.carrier_fingerprint, mono: true },
      ]),
    );
  });
});
