import { describe, expect, it } from "vitest";

import type { FieldCatalogResource } from "@/kernel/api/apiTypes";

import { quantityItemsForVisualizationTarget } from "./ribbonTabViews";

describe("quantityItemsForVisualizationTarget", () => {
  it("offers only catalog full-domain quantities for an Airbox", () => {
    const fieldCatalog = {
      domain_generation_id: "fdm-generation-1",
      quantities: [
        { available: true, domain: "full_domain", quantity_id: "H_demag" },
        { available: true, domain: "full_domain", quantity_id: "H_ant" },
        { available: false, domain: "full_domain", quantity_id: "H_eff" },
        { available: true, domain: "magnetic_only", quantity_id: "m" },
        { available: true, domain: "magnetic_only", quantity_id: "H_ex" },
      ],
      revision: 3,
    } as FieldCatalogResource;

    expect(
      quantityItemsForVisualizationTarget("H_demag", "airbox", fieldCatalog).map(
        (item) => item.value,
      ),
    ).toEqual(["H_demag", "H_ant"]);
    expect(
      quantityItemsForVisualizationTarget("H_eff", "airbox", fieldCatalog),
    ).toEqual([
      { disabled: true, label: "Unavailable / H_eff", value: "H_eff" },
      { label: "Demag field / H_demag", value: "H_demag" },
      { label: "Antenna field / H_ant", value: "H_ant" },
    ]);
    expect(quantityItemsForVisualizationTarget("H_demag", "airbox")).toEqual([]);
  });
});
