import type { FieldCatalogResource } from "@/kernel/api/apiTypes";
import { describe, expect, it } from "vitest";

import {
  resolveTargetFieldAvailability,
  resolveTargetFieldAvailabilityMap,
  targetFieldAvailabilityIsLive,
  targetFieldAvailabilityIsSelectable,
  type TargetFieldCarrierDescriptor,
} from "./targetFieldAvailability";

const target = { id: "object:film", kind: "object" as const };

function catalog(
  overrides: Partial<FieldCatalogResource["quantities"][number]> = {},
): FieldCatalogResource {
  return {
    domain_generation_id: "generation-7",
    quantities: [
      {
        available: true,
        components: 3,
        domain: "magnetic_only",
        domain_generation_id: "generation-7",
        field_revision: 42,
        kind: "vector_field",
        label: "Effective field",
        location: "cell",
        materialization_wall_time_ns: 0,
        materialized_at_unix_ms: 1,
        quantity_id: "H_eff",
        source_revision: 42,
        source_step: 12,
        spatial: true,
        stale_by_steps: 0,
        state: "complete",
        ui_exposed: true,
        unit: "A/m",
        ...overrides,
      },
    ],
    revision: 42,
  };
}

function carrier(
  overrides: Partial<TargetFieldCarrierDescriptor> = {},
): TargetFieldCarrierDescriptor {
  return {
    adopted: false,
    carrierId: "carrier:object-film",
    fieldRevision: 42,
    generationId: "generation-7",
    payloadPointCount: 16,
    payloadState: "ready",
    quantityId: "H_eff",
    scopeId: "object:film",
    scopeKind: "object",
    targetIds: ["object:film"],
    ...overrides,
  };
}

describe("target field availability", () => {
  it("does not treat a global catalog entry as a ready target payload", () => {
    const result = resolveTargetFieldAvailability("H_eff", {
      fieldCatalog: catalog(),
      target,
    });

    expect(result).toMatchObject({
      state: "supported",
      supported: true,
      materialized: false,
      reasonCode: "target_carrier_missing",
    });
    expect(targetFieldAvailabilityIsLive(result)).toBe(false);
  });

  it("keeps materialization explicit while the catalog is pending", () => {
    const result = resolveTargetFieldAvailability("H_eff", {
      carrier: carrier({ payloadState: "pending" }),
      fieldCatalog: catalog({ state: "pending", available: false }),
      target,
    });

    expect(result.state).toBe("materializing");
    expect(result.reasonCode).toBe("field_materialization_pending");
    expect(result.supported).toBe(true);
    expect(targetFieldAvailabilityIsSelectable(result)).toBe(true);
  });

  it("labels a matching last-good target payload stale during rematerialization", () => {
    const result = resolveTargetFieldAvailability("H_eff", {
      carrier: carrier(),
      fieldCatalog: catalog({ state: "pending", available: false }),
      target,
    });

    expect(result).toMatchObject({
      materialized: true,
      reasonCode: "field_materialization_pending",
      state: "stale",
    });
  });

  it("requires matching target identity before reporting a decoded payload ready", () => {
    const result = resolveTargetFieldAvailability("H_eff", {
      carrier: carrier(),
      fieldCatalog: catalog(),
      target,
    });

    expect(result).toMatchObject({
      carrierId: "carrier:object-film",
      materialized: true,
      state: "ready",
      revision: 42,
    });
    expect(targetFieldAvailabilityIsLive(result)).toBe(false);
  });

  it("matches backend object scope ids without the visualization target prefix", () => {
    const result = resolveTargetFieldAvailability("H_eff", {
      carrier: carrier({
        adopted: true,
        scopeId: "film",
      }),
      fieldCatalog: catalog(),
      target: { id: "object:film", kind: "object" },
    });

    expect(result.state).toBe("adopted");
    expect(result.scopeId).toBe("film");
  });

  it("reports adopted only after the renderer confirms the same carrier", () => {
    const result = resolveTargetFieldAvailability("H_eff", {
      carrier: carrier({ adopted: true }),
      fieldCatalog: catalog(),
      target,
    });

    expect(result.state).toBe("adopted");
    expect(result.adopted).toBe(true);
    expect(targetFieldAvailabilityIsLive(result)).toBe(true);
  });

  it("marks generation, scope, and revision mismatches stale", () => {
    const generationMismatch = resolveTargetFieldAvailability("H_eff", {
      carrier: carrier({ generationId: "generation-6" }),
      fieldCatalog: catalog(),
      target,
    });
    const scopeMismatch = resolveTargetFieldAvailability("H_eff", {
      carrier: carrier({ scopeId: "object:other" }),
      fieldCatalog: catalog(),
      target,
    });
    const revisionMismatch = resolveTargetFieldAvailability("H_eff", {
      carrier: carrier({ fieldRevision: 41 }),
      fieldCatalog: catalog(),
      target,
    });

    expect(generationMismatch.state).toBe("stale");
    expect(scopeMismatch.state).toBe("stale");
    expect(revisionMismatch.state).toBe("stale");
    expect(generationMismatch.reasonCode).toBe("target_carrier_identity_mismatch");
  });

  it("does not offer an airbox-only quantity to a magnetic target", () => {
    const result = resolveTargetFieldAvailability("H_eff", {
      fieldCatalog: catalog({
        domain: "magnetic_only",
        location: "airbox_only",
      }),
      target,
    });

    expect(result.state).toBe("unavailable");
    expect(result.reasonCode).toBe("quantity_domain_mismatch");
    expect(targetFieldAvailabilityIsSelectable(result)).toBe(false);
  });

  it("keeps a supported quantity selectable after a retryable materialization error", () => {
    expect(
      targetFieldAvailabilityIsSelectable({
        adopted: false,
        carrierId: null,
        generationId: "generation-1",
        materialized: false,
        quantityId: "H_demag",
        reasonCode: "field_materialization_error",
        revision: null,
        scopeId: "airbox",
        scopeKind: "airbox",
        state: "unavailable",
        supported: true,
        targetId: "airbox",
      }),
    ).toBe(true);
  });

  it("keeps the single-grid outside-support target on its full-grid carrier scope", () => {
    const result = resolveTargetFieldAvailability("H_eff", {
      carrier: carrier({
        scopeId: null,
        scopeKind: "full",
        targetIds: ["fdm-universe-outside-support"],
      }),
      fieldCatalog: catalog({ domain: "full_domain" }),
      target: {
        id: "fdm-universe-outside-support",
        kind: "fdm-domain",
      },
    });

    expect(result.state).toBe("ready");
    expect(result.scopeKind).toBe("full");
    expect(result.scopeId).toBeNull();
  });

  it("returns a canonical map for multiple quantities without reading payload values", () => {
    const result = resolveTargetFieldAvailabilityMap({
      fieldCatalog: catalog(),
      quantityIds: ["H_eff", "H_demag"],
      target,
    });

    expect([...result.keys()]).toEqual(["H_eff", "H_demag"]);
    expect(result.get("H_eff")?.state).toBe("supported");
    expect(result.get("H_demag")?.state).toBe("unavailable");
  });
});
