import { describe, expect, it } from "vitest";

import { metadataOnlyLatestFieldFrame } from "../useNewApiBridge";
import type { FieldFrameEnvelope } from "@/lib/fieldFrame/types";

function envelope(overrides: Partial<FieldFrameEnvelope> = {}): FieldFrameEnvelope {
  return {
    sessionId: "session-a",
    runId: "run-a",
    backendEpoch: 0,
    meshGenerationId: "7",
    topologyHash: null,
    fieldRevision: 12,
    sourceStep: 34,
    sourceTime: 5e-9,
    quantityId: "H_eff",
    component: "3D",
    nComp: 3,
    domain: "magnetic_only",
    location: "node",
    dtype: "f64",
    payloadKind: "binary-ref",
    payloadId: null,
    activeMaskId: null,
    stats: null,
    ...overrides,
  };
}

describe("metadataOnlyLatestFieldFrame", () => {
  it("preserves field identity without retaining raw field values", () => {
    const frame = metadataOnlyLatestFieldFrame(envelope(), [8, 4, 2]);

    expect(frame.quantity_id).toBe("H_eff");
    expect(frame.field_revision).toBe(12);
    expect(frame.grid).toEqual([8, 4, 2]);
    expect(frame.topology_signature).toBe("gen:7");
    expect(frame.values.byteLength).toBe(0);
  });
});
