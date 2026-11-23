import { describe, expect, it } from "vitest";

import type { QuantityCatalogResource } from "./apiTypes";
import {
  isScalarSpatialQuantityId,
  quantityCatalogEntryHasAdoptableSpatialCarrier,
  quantityCatalogEntrySupportsAirbox,
  quantityCatalogEntrySupportsSpatialVisualization,
  quantityUnitForColorbar,
  resolveCanonicalQuantityId,
} from "./quantityIds";

describe("quantity catalog visualization selector", () => {
  it("normalizes rotated DMI IDs and exposes canonical SI units", () => {
    expect(resolveCanonicalQuantityId("h_rotated_dmi")).toBe("H_rotated_dmi");
    expect(resolveCanonicalQuantityId("e_rotated_dmi")).toBe("E_rotated_dmi");
    expect(resolveCanonicalQuantityId("eden_rotated_dmi")).toBe("eden_rotated_dmi");
    expect(quantityUnitForColorbar("H_rotated_dmi")).toBe("A/m");
    expect(quantityUnitForColorbar("E_rotated_dmi")).toBe("J");
    expect(quantityUnitForColorbar("eden_rotated_dmi")).toBe("J/m³");
    expect(isScalarSpatialQuantityId("eden_rotated_dmi")).toBe(true);
  });

  it("treats the resolved Frozen Spins mask as a canonical scalar viewport quantity", () => {
    expect(resolveCanonicalQuantityId("frozen_spins")).toBe("frozen_spins");
    expect(resolveCanonicalQuantityId("frozen_mask")).toBe("frozen_spins");
    expect(isScalarSpatialQuantityId("frozen_spins")).toBe(true);
    expect(quantityUnitForColorbar("frozen_spins")).toBe("1");

    const quantity = {
      id: "frozen_spins",
      domain: "magnetic_only",
      interactive_preview: true,
      location: "node",
      materializable: true,
      renderable: true,
      requestable: true,
      solver_capability: "supported",
      supports_preview_3d: true,
      resolved_capability: {
        provider: "available",
        request: "field_vector",
        materialization: "materialized",
        render: "renderable",
        publication: "interactive",
        scope: "magnetic_only",
        reason_code: null,
        lane: "fdm_cpu_reference",
        precision: "double",
        carriers: [
          {
            carrier_id: "fdm:resolved-grid:full",
            scope: "full",
            scope_kind: "full",
            components: 1,
            indexing: "cell",
            view: "full",
            payload_state: "current",
          },
        ],
      },
    } as unknown as QuantityCatalogResource["quantities"][number];

    expect(quantityCatalogEntrySupportsSpatialVisualization(quantity)).toBe(true);
    expect(quantityCatalogEntryHasAdoptableSpatialCarrier(quantity)).toBe(true);
    expect(quantityCatalogEntrySupportsAirbox(quantity)).toBe(false);
  });

  it("separates requestable quantities from adoptable carrier evidence", () => {
    const quantity = {
      id: "H_demag",
      interactive_preview: true,
      location: "node",
      materializable: true,
      renderable: true,
      requestable: true,
      solver_capability: "supported",
      supports_preview_3d: true,
      resolved_capability: {
        provider: "available",
        request: "field_vector",
        materialization: "unmaterialized",
        render: "renderable",
        publication: "interactive",
        scope: "full_domain",
        reason_code: "field_unmaterialized",
        lane: "fem_cpu_native",
        precision: "double",
        carriers: [],
      },
    } as unknown as QuantityCatalogResource["quantities"][number];

    expect(quantityCatalogEntrySupportsSpatialVisualization(quantity)).toBe(true);
    expect(quantityCatalogEntryHasAdoptableSpatialCarrier(quantity)).toBe(false);

    const materialized = {
      ...quantity,
      resolved_capability: {
        ...quantity.resolved_capability!,
        materialization: "materialized",
        reason_code: null,
        carriers: [
          {
            carrier_id: "fdm:verified-grid:full",
            scope: "full",
            scope_kind: "full",
            components: 3,
            indexing: "cell",
            view: "full",
            payload_state: "current",
          },
        ],
      },
    } as QuantityCatalogResource["quantities"][number];
    expect(quantityCatalogEntryHasAdoptableSpatialCarrier(materialized)).toBe(true);
  });

  it("uses resolved carrier metadata and rejects legacy-unverified payloads", () => {
    const quantity = {
      id: "H_demag",
      interactive_preview: true,
      location: "node",
      materializable: true,
      renderable: true,
      requestable: true,
      solver_capability: "supported",
      supports_preview_3d: true,
      resolved_capability: {
        provider: "available",
        request: "field_vector",
        materialization: "legacy_unverified",
        render: "renderable",
        publication: "interactive",
        scope: "full_domain",
        reason_code: "legacy_unverified",
        lane: "fem_cpu_native",
        precision: "double",
        carriers: [
          {
            carrier_id: "legacy:H_demag",
            scope: "full_domain",
            components: 3,
            indexing: "legacy_count_only",
            view: "full",
            payload_version: "fmvp.v2",
            payload_state: "legacy_unverified",
          },
        ],
      },
    } as QuantityCatalogResource["quantities"][number];

    expect(quantityCatalogEntrySupportsSpatialVisualization(quantity)).toBe(false);
    expect(quantityCatalogEntryHasAdoptableSpatialCarrier(quantity)).toBe(false);
  });

  it("keeps a requestable full-domain quantity selectable after a materialization error", () => {
    const quantity = {
      domain: "full_domain",
      id: "H_demag",
      resolved_capability: {
        provider: "available",
        request: "field_vector",
        materialization: "unavailable",
        render: "renderable",
        publication: "interactive",
        scope: "full_domain",
        reason_code: "field_materialization_error",
        lane: "fdm_cuda",
        precision: "double",
        carriers: [],
      },
    } as unknown as QuantityCatalogResource["quantities"][number];

    expect(quantityCatalogEntrySupportsSpatialVisualization(quantity)).toBe(true);
    expect(quantityCatalogEntrySupportsAirbox(quantity)).toBe(true);
    expect(quantityCatalogEntryHasAdoptableSpatialCarrier(quantity)).toBe(false);
  });

  it("accepts prepared_initial_state magnetization with true resolved lane without requiring unresolved", () => {
    const basePreparedM = {
      id: "m",
      domain: "magnetic_only",
      shape: "vector_field",
      location: "node",
      n_comp: 3,
      capability_state: "unsupported",
      solver_capability: "unsupported",
      requestable: true,
      materializable: false,
      renderable: true,
      interactive_preview: true,
      supports_preview_3d: true,
      publication_state: "interactive",
      resolved_capability: {
        quantity_id: "m",
        provider: "unavailable",
        reason_code: "prepared_initial_state",
        lane: "fdm_cpu_reference",
        scope: "magnetic_only",
        request: "field_vector",
        materialization: "materialized",
        render: "renderable",
        publication: "interactive",
        precision: "double",
        carriers: [
          {
            carrier_id: "prepared:m:full",
            carrier_fingerprint: "fp-1",
            components: 3,
            indexing: "node",
            scope: "full",
            scope_kind: "full",
            view: "3D",
            payload_state: "current",
          },
        ],
      },
    } as unknown as QuantityCatalogResource["quantities"][number];

    expect(quantityCatalogEntrySupportsSpatialVisualization(basePreparedM)).toBe(true);
    expect(
      quantityCatalogEntrySupportsSpatialVisualization({
        ...basePreparedM,
        resolved_capability: {
          ...basePreparedM.resolved_capability!,
          lane: "fem_cpu_native",
        },
      }),
    ).toBe(true);
    expect(
      quantityCatalogEntrySupportsSpatialVisualization({
        ...basePreparedM,
        resolved_capability: {
          ...basePreparedM.resolved_capability!,
          lane: "unresolved",
        },
      }),
    ).toBe(true);
    expect(
      quantityCatalogEntrySupportsSpatialVisualization({
        ...basePreparedM,
        resolved_capability: {
          ...basePreparedM.resolved_capability!,
          lane: "",
        },
      }),
    ).toBe(false);
  });
});
