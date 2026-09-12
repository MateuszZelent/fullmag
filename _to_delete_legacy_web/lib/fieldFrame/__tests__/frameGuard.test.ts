import { describe, expect, it } from "vitest";

import {
  shouldAcceptFrame,
  computeFrameStaleness,
} from "../frameGuard";
import type { FieldFrameEnvelope } from "../types";

function makeEnvelope(overrides: Partial<FieldFrameEnvelope> = {}): FieldFrameEnvelope {
  return {
    sessionId: "session-1",
    runId: "run-1",
    backendEpoch: 0,
    meshGenerationId: "mesh-gen-1",
    topologyHash: null,
    fieldRevision: 1,
    sourceStep: 1,
    sourceTime: 1e-12,
    quantityId: "m",
    component: "3D",
    nComp: 3,
    domain: "magnetic_only",
    location: "node",
    dtype: "f64",
    payloadKind: "inline-json",
    payloadId: null,
    activeMaskId: null,
    stats: null,
    ...overrides,
  };
}

describe("shouldAcceptFrame", () => {
  it("accepts any frame when prev is null", () => {
    const next = makeEnvelope();
    expect(shouldAcceptFrame(null, next)).toBe(true);
  });

  it("accepts frame with different sessionId", () => {
    const prev = makeEnvelope({ sessionId: "session-1" });
    const next = makeEnvelope({ sessionId: "session-2", fieldRevision: 0 });
    expect(shouldAcceptFrame(prev, next)).toBe(true);
  });

  it("accepts frame with different runId", () => {
    const prev = makeEnvelope({ runId: "run-1" });
    const next = makeEnvelope({ runId: "run-2", fieldRevision: 0 });
    expect(shouldAcceptFrame(prev, next)).toBe(true);
  });

  it("accepts frame with higher backendEpoch", () => {
    const prev = makeEnvelope({ backendEpoch: 1 });
    const next = makeEnvelope({ backendEpoch: 2, fieldRevision: 0 });
    expect(shouldAcceptFrame(prev, next)).toBe(true);
  });

  it("rejects frame with lower backendEpoch", () => {
    const prev = makeEnvelope({ backendEpoch: 2 });
    const next = makeEnvelope({ backendEpoch: 1, fieldRevision: 99 });
    expect(shouldAcceptFrame(prev, next)).toBe(false);
  });

  it("accepts frame with different meshGenerationId", () => {
    const prev = makeEnvelope({ meshGenerationId: "gen-A" });
    const next = makeEnvelope({ meshGenerationId: "gen-B", fieldRevision: 0 });
    expect(shouldAcceptFrame(prev, next)).toBe(true);
  });

  it("accepts frame with higher fieldRevision (normal solver tick)", () => {
    const prev = makeEnvelope({ fieldRevision: 10 });
    const next = makeEnvelope({ fieldRevision: 11 });
    expect(shouldAcceptFrame(prev, next)).toBe(true);
  });

  it("rejects frame with equal fieldRevision (duplicate)", () => {
    const prev = makeEnvelope({ fieldRevision: 10 });
    const next = makeEnvelope({ fieldRevision: 10 });
    expect(shouldAcceptFrame(prev, next)).toBe(false);
  });

  it("rejects frame with lower fieldRevision (out-of-order)", () => {
    const prev = makeEnvelope({ fieldRevision: 10 });
    const next = makeEnvelope({ fieldRevision: 9 });
    expect(shouldAcceptFrame(prev, next)).toBe(false);
  });

  // T4: Out-of-order frame scenario from P7
  it("T4: out-of-order frames — step 10 applied, step 9 arrives late, step 11 arrives", () => {
    const frame10 = makeEnvelope({ fieldRevision: 10, sourceStep: 10 });
    const frame9 = makeEnvelope({ fieldRevision: 9, sourceStep: 9 });
    const frame11 = makeEnvelope({ fieldRevision: 11, sourceStep: 11 });

    // frame 10 applied as first frame
    expect(shouldAcceptFrame(null, frame10)).toBe(true);
    // frame 9 arrives late — rejected
    expect(shouldAcceptFrame(frame10, frame9)).toBe(false);
    // frame 11 arrives — accepted
    expect(shouldAcceptFrame(frame10, frame11)).toBe(true);
  });

  it("skips meshGenerationId comparison when either is null", () => {
    const prev = makeEnvelope({ meshGenerationId: null, fieldRevision: 5 });
    const next = makeEnvelope({ meshGenerationId: "gen-B", fieldRevision: 3 });
    // Should fall through to fieldRevision comparison → 3 < 5 → reject
    expect(shouldAcceptFrame(prev, next)).toBe(false);
  });

  it("accepts when prev meshGenerationId is null but fieldRevision is higher", () => {
    const prev = makeEnvelope({ meshGenerationId: null, fieldRevision: 5 });
    const next = makeEnvelope({ meshGenerationId: "gen-B", fieldRevision: 6 });
    expect(shouldAcceptFrame(prev, next)).toBe(true);
  });
});

describe("computeFrameStaleness", () => {
  it("reports stale when no envelope applied and solver has stepped", () => {
    const result = computeFrameStaleness(null, 100);
    expect(result.isStale).toBe(true);
    expect(result.staleSteps).toBe(100);
    expect(result.appliedFieldRevision).toBe(0);
    expect(result.appliedSourceStep).toBe(0);
    expect(result.currentSolverStep).toBe(100);
  });

  it("reports not stale when envelope step matches solver step", () => {
    const envelope = makeEnvelope({ sourceStep: 50, fieldRevision: 50 });
    const result = computeFrameStaleness(envelope, 50);
    expect(result.isStale).toBe(false);
    expect(result.staleSteps).toBe(0);
  });

  it("reports stale with correct step count", () => {
    const envelope = makeEnvelope({ sourceStep: 48, fieldRevision: 48 });
    const result = computeFrameStaleness(envelope, 51);
    expect(result.isStale).toBe(true);
    expect(result.staleSteps).toBe(3);
    expect(result.appliedSourceStep).toBe(48);
    expect(result.currentSolverStep).toBe(51);
  });

  it("never reports negative staleness", () => {
    // Edge case: envelope source step ahead of solver (shouldn't happen, but be safe)
    const envelope = makeEnvelope({ sourceStep: 100, fieldRevision: 100 });
    const result = computeFrameStaleness(envelope, 90);
    expect(result.isStale).toBe(false);
    expect(result.staleSteps).toBe(0);
  });

  it("reports not stale when solver is at step 0 and no envelope", () => {
    const result = computeFrameStaleness(null, 0);
    expect(result.isStale).toBe(false);
    expect(result.staleSteps).toBe(0);
  });
});
