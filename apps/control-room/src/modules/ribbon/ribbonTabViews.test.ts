import { describe, expect, it } from "vitest";

import type {
  FieldCatalogResource,
  QuantityCatalogResource,
} from "@/kernel/api/apiTypes";

import { quantityItemsForVisualizationTarget } from "./ribbonTabViews";

describe("quantityItemsForVisualizationTarget", () => {
  it("shows only the active disabled loading item before catalogs arrive", () => {
    expect(quantityItemsForVisualizationTarget("H_demag", "object")).toEqual([
      {
        disabled: true,
        label: "Loading quantity catalog / H_demag",
        value: "H_demag",
      },
    ]);
  });

  it("offers advertised materializable quantities before field payloads exist", () => {
    const fieldCatalog = {
      domain_generation_id: "fdm-generation-1",
      quantities: [],
      revision: 3,
    } as FieldCatalogResource;
    const quantityCatalog = {
      schema_version: "v1",
      quantities: [
        {
          capability_state: "supported",
          solver_capability: "supported",
          requestable: true,
          renderable: true,
          publication_state: "published",
          description: "Demagnetization field",
          domain: "full_domain",
          id: "H_demag",
          interactive_preview: true,
          label: "Demag field",
          location: "node",
          materializable: true,
          materialization_state: "unmaterialized",
          n_comp: 3,
          normalization_hint: "max_abs",
          shape: "vector_field",
          supports_export: true,
          supports_history: false,
          supports_preview_2d: true,
          supports_preview_3d: true,
          unit: "A/m",
        },
        {
          capability_state: "supported",
          solver_capability: "supported",
          requestable: true,
          renderable: true,
          publication_state: "published",
          description: "Demag energy density",
          domain: "magnetic_only",
          id: "eden_demag",
          interactive_preview: true,
          label: "Demag energy density",
          location: "cell",
          materializable: true,
          materialization_state: "unmaterialized",
          n_comp: 1,
          normalization_hint: "signed",
          shape: "spatial_scalar",
          supports_export: true,
          supports_history: false,
          supports_preview_2d: true,
          supports_preview_3d: true,
          unit: "J/m³",
        },
      ],
    } as QuantityCatalogResource;

    expect(
      quantityItemsForVisualizationTarget(
        "H_demag",
        "airbox",
        fieldCatalog,
        quantityCatalog,
      ).map((item) => item.value),
    ).toEqual(["H_demag"]);
    expect(
      quantityItemsForVisualizationTarget(
        "eden_demag",
        "object",
        fieldCatalog,
        quantityCatalog,
      ).map((item) => item.value),
    ).toEqual(["H_demag", "eden_demag"]);
  });

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
      { label: "H_demag", value: "H_demag" },
      { label: "H_ant", value: "H_ant" },
    ]);
    expect(quantityItemsForVisualizationTarget("H_demag", "airbox")).toEqual([
      {
        disabled: true,
        label: "Loading quantity catalog / H_demag",
        value: "H_demag",
      },
    ]);
  });

  it("does not preserve an incompatible active magnetization item in the Airbox list", () => {
    const fieldCatalog = {
      domain_generation_id: "fdm-generation-1",
      quantities: [
        { available: true, domain: "magnetic_only", quantity_id: "m" },
        { available: true, domain: "full_domain", quantity_id: "H_demag" },
      ],
      revision: 3,
    } as FieldCatalogResource;

    expect(
      quantityItemsForVisualizationTarget("m", "airbox", fieldCatalog),
    ).toEqual([{ label: "H_demag", value: "H_demag" }]);
  });

  it("uses every available spatial catalog quantity for objects, and only full-domain ones for an Airbox", () => {
    const fieldCatalog = {
      domain_generation_id: "fdm-generation-1",
      quantities: [
        { available: true, ui_exposed: true, kind: "vector_field", location: "node", domain: "magnetic_only", quantity_id: "m", label: "Magnetization", unit: "1" },
        { available: true, ui_exposed: true, kind: "vector_field", location: "node", domain: "full_domain", quantity_id: "H_eff", label: "Effective field", unit: "A/m" },
        { available: true, ui_exposed: true, kind: "vector_field", location: "node", domain: "full_domain", quantity_id: "H_demag", label: "Demag field", unit: "A/m" },
        { available: true, ui_exposed: true, kind: "vector_field", location: "node", domain: "full_domain", quantity_id: "H_ext", label: "External field", unit: "A/m" },
        { available: true, ui_exposed: true, kind: "vector_field", location: "node", domain: "full_domain", quantity_id: "H_oe", label: "Oersted field", unit: "A/m" },
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
    ).toEqual(["H_eff", "H_demag", "H_ext", "H_oe"]);
    expect(
      quantityItemsForVisualizationTarget("H_therm", "object", fieldCatalog)[0],
    ).toEqual({ disabled: true, label: "Unavailable / H_therm", value: "H_therm" });
  });
});
