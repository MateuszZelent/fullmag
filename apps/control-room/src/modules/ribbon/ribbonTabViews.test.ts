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

  it("uses every available spatial catalog quantity for objects, and only full-domain ones for an Airbox", () => {
    const fieldCatalog = {
      domain_generation_id: "fdm-generation-1",
      quantities: [
        { available: true, ui_exposed: true, kind: "vector_field", location: "node", domain: "magnetic_only", quantity_id: "m", label: "Magnetization", unit: "1" },
        { available: true, ui_exposed: true, kind: "vector_field", location: "node", domain: "full_domain", quantity_id: "H_eff", label: "Effective field", unit: "A/m" },
        { available: true, ui_exposed: true, kind: "vector_field", location: "node", domain: "full_domain", quantity_id: "H_demag", label: "Demag field", unit: "A/m" },
        { available: true, ui_exposed: true, kind: "vector_field", location: "node", domain: "full_domain", quantity_id: "H_ext", label: "External field", unit: "A/m" },
        { available: true, ui_exposed: true, kind: "vector_field", location: "node", domain: "magnetic_only", quantity_id: "H_oe", label: "Oersted field", unit: "A/m" },
        { available: true, ui_exposed: true, kind: "vector_field", location: "node", domain: "magnetic_only", quantity_id: "H_dmi", label: "DMI field", unit: "A/m" },
        { available: true, ui_exposed: true, kind: "spatial_scalar", location: "cell", domain: "magnetic_only", quantity_id: "eden_demag", label: "Demag energy density", unit: "J/m³" },
        { available: false, ui_exposed: true, kind: "vector_field", location: "node", domain: "full_domain", quantity_id: "H_therm", label: "Thermal field", unit: "A/m" },
        { available: true, ui_exposed: false, kind: "spatial_scalar", location: "node", domain: "full_domain", quantity_id: "phi", label: "Demag potential", unit: "A" },
        { available: true, ui_exposed: true, kind: "global_scalar", location: "global", domain: "magnetic_only", quantity_id: "E_total", label: "Total energy", unit: "J" },
      ],
      revision: 3,
    } as FieldCatalogResource;

    expect(
      quantityItemsForVisualizationTarget("H_eff", "object", fieldCatalog).map(
        (item) => item.value,
      ),
    ).toEqual(["m", "H_eff", "H_demag", "H_ext", "H_oe", "H_dmi", "eden_demag"]);
    expect(
      quantityItemsForVisualizationTarget("H_eff", "airbox", fieldCatalog).map(
        (item) => item.value,
      ),
    ).toEqual(["H_eff", "H_demag", "H_ext"]);
    expect(
      quantityItemsForVisualizationTarget("H_therm", "object", fieldCatalog)[0],
    ).toEqual({ disabled: true, label: "Unavailable / H_therm", value: "H_therm" });
  });
});
