import { describe, expect, it } from "vitest";

import type { Viewport3DRenderAdoptionReceipt } from "./viewport3DRenderAdoptionRegistry";
import { resolveCurrentViewport3DVectorAdoption } from "./viewport3DVectorAdoptionPresentation";

const sessionIdentity = {
  requestScopeEpoch: "scope-4",
  sessionEpoch: "session-2",
  sessionId: "session-1",
} as const;

const target = {
  buildReference: {
    buildKey: "fdm-vector:current-generation",
    fieldBufferId: "field-buffer:current",
    fieldRevision: "field-revision:9",
    groupKey: "fdm-target-vector:object:film",
    resourceKey: "field-resource:current",
    revisionSummary: "topology=current",
    targetRevision: "settings=current",
    topologyRevision: "topology=current",
  },
  carrierIds: ["object:film"],
  targetId: "object:film",
  segments: new Float32Array(6 * 2_130),
};

function receipt(
  overrides: Partial<Viewport3DRenderAdoptionReceipt> = {},
): Viewport3DRenderAdoptionReceipt {
  return {
    adoptedAtMs: 1,
    adoptionSequence: 3,
    byteLength: 2_130 * 12,
    carrierId: "object:film",
    fieldBufferId: "field-buffer:current",
    itemCount: 2_130,
    kind: "vector",
    requestScopeEpoch: sessionIdentity.requestScopeEpoch,
    resourceKey: "field-resource:current",
    scalarBufferKey: null,
    sessionEpoch: sessionIdentity.sessionEpoch,
    sessionId: sessionIdentity.sessionId,
    targetId: "object:film",
    vectorBuildKey: "fdm-vector:current-generation",
    ...overrides,
  };
}

describe("current viewport vector adoption presentation", () => {
  it("returns an adopted count only for the active target's exact current vector build", () => {
    expect(
      resolveCurrentViewport3DVectorAdoption({
        receipts: [receipt()],
        sessionIdentity,
        target,
      }),
    ).toMatchObject({
      carrierId: "object:film",
      fieldBufferId: "field-buffer:current",
      itemCount: 2_130,
      resourceKey: "field-resource:current",
      targetId: "object:film",
      vectorBuildKey: "fdm-vector:current-generation",
    });
  });

  it.each([
    ["another target", { targetId: "object:other" }],
    ["an older build generation", { vectorBuildKey: "fdm-vector:old-generation" }],
    ["another field buffer", { fieldBufferId: "field-buffer:old" }],
    ["another field resource", { resourceKey: "field-resource:old" }],
    ["another session request scope", { requestScopeEpoch: "scope-old" }],
    ["a surface receipt", { kind: "surface" as const }],
    ["a missing count", { itemCount: undefined }],
  ])("rejects the renderer count when it belongs to %s", (_reason, overrides) => {
    expect(
      resolveCurrentViewport3DVectorAdoption({
        receipts: [receipt(overrides)],
        sessionIdentity,
        target,
      }),
    ).toBeNull();
  });

  it("does not publish when the current target has no vector geometry or session identity", () => {
    expect(
      resolveCurrentViewport3DVectorAdoption({
        receipts: [receipt()],
        sessionIdentity: null,
        target: { ...target, segments: null },
      }),
    ).toBeNull();
  });
});
