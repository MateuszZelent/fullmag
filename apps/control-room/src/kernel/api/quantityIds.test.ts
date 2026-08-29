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
});
