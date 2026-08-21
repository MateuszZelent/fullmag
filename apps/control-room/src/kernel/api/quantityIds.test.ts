import { describe, expect, it } from "vitest";

import type { QuantityCatalogResource } from "./apiTypes";
import {
  quantityCatalogEntryHasAdoptableSpatialCarrier,
  quantityCatalogEntrySupportsSpatialVisualization,
} from "./quantityIds";

describe("quantity catalog visualization selector", () => {
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
});
