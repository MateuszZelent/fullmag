import { describe, expect, it, vi } from "vitest";

import { createViewport3DRenderAdoptionRegistry } from "./viewport3DRenderAdoptionRegistry";

describe("viewport3DRenderAdoptionRegistry", () => {
  it("does not retain adoption evidence while debug demand is closed", () => {
    const registry = createViewport3DRenderAdoptionRegistry();

    registry.recordSurfaceAdoption({
      byteLength: 48,
      carrierId: "part:air",
      fieldBufferId: "field-1",
      scalarBufferKey: "scalar-1",
      targetId: "airbox",
    });
    registry.recordVectorAdoption({
      byteLength: 96,
      carrierId: "part:air",
      fieldBufferId: "field-1",
      targetId: "airbox",
      vectorBuildKey: "vector-1",
    });

    expect(registry.snapshot("airbox")).toEqual([]);
  });

  it("records bounded target and carrier specific surface and vector receipts", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    const release = registry.retainDemand("airbox");

    registry.recordSurfaceAdoption({
      byteLength: 48,
      carrierId: "part:air-a",
      fieldBufferId: "field-a",
      scalarBufferKey: "scalar-a",
      targetId: "airbox",
    });
    registry.recordVectorAdoption({
      byteLength: 96,
      carrierId: "part:air-b",
      fieldBufferId: "field-b",
      targetId: "airbox",
      vectorBuildKey: "vector-b",
    });

    expect(registry.snapshot("airbox")).toEqual([
      {
        adoptedAtMs: expect.any(Number),
        adoptionSequence: 1,
        byteLength: 48,
        carrierId: "part:air-a",
        fieldBufferId: "field-a",
        kind: "surface",
        resourceKey: null,
        scalarBufferKey: "scalar-a",
        targetId: "airbox",
        vectorBuildKey: null,
      },
      {
        adoptedAtMs: expect.any(Number),
        adoptionSequence: 2,
        byteLength: 96,
        carrierId: "part:air-b",
        fieldBufferId: "field-b",
        kind: "vector",
        resourceKey: null,
        scalarBufferKey: null,
        targetId: "airbox",
        vectorBuildKey: "vector-b",
      },
    ]);

    release();
    expect(registry.snapshot("airbox")).toEqual([]);
  });

  it("notifies only for semantic receipt changes and clears target removal", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    registry.retainDemand("object:a");
    const receipt = {
      byteLength: 24,
      carrierId: "part:a",
      fieldBufferId: "field-a",
      scalarBufferKey: "scalar-a",
      targetId: "object:a",
    } as const;

    registry.recordSurfaceAdoption(receipt);
    registry.recordSurfaceAdoption(receipt);
    expect(listener).toHaveBeenCalledTimes(1);

    registry.clearTarget("object:a");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.snapshot("object:a")).toEqual([]);
    unsubscribe();
  });

  it("advances adoption identity only for a newly adopted payload", () => {
    let adoptedAtMs = 1_000;
    const registry = createViewport3DRenderAdoptionRegistry({
      now: () => adoptedAtMs,
    });
    registry.retainDemand("object:a");
    const first = {
      byteLength: 24,
      carrierId: "part:a",
      fieldBufferId: "field-a",
      resourceKey: "resource-a",
      scalarBufferKey: "scalar-a",
      targetId: "object:a",
    } as const;

    registry.recordSurfaceAdoption(first);
    expect(registry.snapshot("object:a")[0]).toMatchObject({
      adoptedAtMs: 1_000,
      adoptionSequence: 1,
    });

    adoptedAtMs = 2_000;
    registry.recordSurfaceAdoption(first);
    expect(registry.snapshot("object:a")[0]).toMatchObject({
      adoptedAtMs: 1_000,
      adoptionSequence: 1,
    });

    registry.recordSurfaceAdoption({
      ...first,
      fieldBufferId: "field-b",
      resourceKey: "resource-b",
      scalarBufferKey: "scalar-b",
    });
    expect(registry.snapshot("object:a")[0]).toMatchObject({
      adoptedAtMs: 2_000,
      adoptionSequence: 2,
      fieldBufferId: "field-b",
    });
  });

  it("identifies the exact target affected by each semantic receipt change", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    registry.retainDemand("object:a");
    registry.retainDemand("object:b");

    registry.recordSurfaceAdoption({
      byteLength: 24,
      carrierId: "part:a",
      fieldBufferId: "field-a",
      scalarBufferKey: "scalar-a",
      targetId: "object:a",
    });
    registry.recordVectorAdoption({
      byteLength: 48,
      carrierId: "part:b",
      fieldBufferId: "field-b",
      targetId: "object:b",
      vectorBuildKey: "vector-b",
    });

    expect(listener.mock.calls).toEqual([["object:a"], ["object:b"]]);
  });

  it("attributes one derived-global FDM carrier to every demanded logical target", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(
      new Map([["fdm-domain", ["object:a", "object:b"]]]),
    );
    registry.retainDemand("object:a");
    registry.retainDemand("object:b");

    registry.recordVectorAdoption({
      byteLength: 64,
      carrierId: "fdm-domain",
      fieldBufferId: "field-global",
      vectorBuildKey: "vector-global",
    });

    expect(registry.snapshot("object:a")).toHaveLength(1);
    expect(registry.snapshot("object:b")).toHaveLength(1);
  });

  it("replays an already adopted layer buffer when debug demand opens later", () => {
    let adoptedAtMs = 1_000;
    const registry = createViewport3DRenderAdoptionRegistry({
      now: () => adoptedAtMs,
    });
    registry.setCarrierTargets(new Map([["part:a", ["object:a"]]]));
    registry.recordVectorAdoption({
      byteLength: 64,
      carrierId: "part:a",
      fieldBufferId: "field-visible",
      vectorBuildKey: "vector-visible",
    });
    const replay = vi.fn(() => {
      registry.recordVectorAdoption({
        byteLength: 64,
        carrierId: "part:a",
        fieldBufferId: "field-visible",
        vectorBuildKey: "vector-visible",
      });
    });
    const unregister = registry.registerCarrierAdoptionReplay("part:a", replay);
    adoptedAtMs = 2_000;

    expect(registry.snapshot("object:a")).toEqual([]);
    const release = registry.retainDemand("object:a");

    expect(replay).toHaveBeenCalledTimes(1);
    expect(registry.snapshot("object:a")[0]).toMatchObject({
      adoptedAtMs: 1_000,
      adoptionSequence: 1,
      fieldBufferId: "field-visible",
      vectorBuildKey: "vector-visible",
    });
    release();
    unregister();
  });

  it("clears only the exact carrier/kind/source receipt and ignores stale cleanup tokens", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(
      new Map([
        ["part:a", ["object:a"]],
        ["part:b", ["object:a"]],
      ]),
    );
    registry.retainDemand("object:a");
    registry.recordSurfaceAdoption({
      byteLength: 12,
      carrierId: "part:a",
      fieldBufferId: "field-old",
      resourceKey: "resource-old",
      scalarBufferKey: "scalar-old",
    });
    registry.recordVectorAdoption({
      byteLength: 24,
      carrierId: "part:a",
      fieldBufferId: "field-vector",
      resourceKey: "resource-vector",
      vectorBuildKey: "vector-a",
    });
    registry.recordSurfaceAdoption({
      byteLength: 36,
      carrierId: "part:b",
      fieldBufferId: "field-b",
      resourceKey: "resource-b",
      scalarBufferKey: "scalar-b",
    });
    registry.recordSurfaceAdoption({
      byteLength: 48,
      carrierId: "part:a",
      fieldBufferId: "field-new",
      resourceKey: "resource-new",
      scalarBufferKey: "scalar-new",
    });

    registry.clearAdoption({
      carrierId: "part:a",
      fieldBufferId: "field-old",
      kind: "surface",
      resourceKey: "resource-old",
      scalarBufferKey: "scalar-old",
      vectorBuildKey: null,
    });
    expect(registry.snapshot("object:a")).toHaveLength(3);

    registry.clearAdoption({
      carrierId: "part:a",
      fieldBufferId: "field-vector",
      kind: "vector",
      resourceKey: "resource-vector",
      scalarBufferKey: null,
      vectorBuildKey: "vector-a",
    });
    expect(registry.snapshot("object:a")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ carrierId: "part:a", kind: "surface" }),
        expect.objectContaining({ carrierId: "part:b", kind: "surface" }),
      ]),
    );
    expect(registry.snapshot("object:a")).toHaveLength(2);
  });

  it("does not replay a cleared adoption after layer cleanup while demand remains open", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    const carrierTargets = new Map([["part:a", ["object:a"]]]);
    registry.setCarrierTargets(carrierTargets);
    const adoption = {
      carrierId: "part:a",
      fieldBufferId: "field-a",
      kind: "surface" as const,
      resourceKey: "resource-a",
      scalarBufferKey: "scalar-a",
      vectorBuildKey: null,
    };
    const replay = vi.fn(() => {
      registry.recordSurfaceAdoption({
        byteLength: 12,
        carrierId: adoption.carrierId,
        fieldBufferId: adoption.fieldBufferId,
        resourceKey: adoption.resourceKey,
        scalarBufferKey: adoption.scalarBufferKey,
      });
    });
    const unregister = registry.registerCarrierAdoptionReplay("part:a", replay);
    registry.retainDemand("object:a");
    expect(registry.snapshot("object:a")).toHaveLength(1);

    unregister();
    registry.clearAdoption(adoption);
    registry.setCarrierTargets(carrierTargets);

    expect(registry.snapshot("object:a")).toEqual([]);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("keeps an identical pass adopted until every overlapping owner releases it", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.retainDemand("object:a");
    const identity = {
      carrierId: "part:a",
      fieldBufferId: "field-a",
      kind: "surface" as const,
      resourceKey: "resource-a",
      scalarBufferKey: "scalar-a",
      vectorBuildKey: null,
    };
    const input = {
      byteLength: 24,
      carrierId: identity.carrierId,
      fieldBufferId: identity.fieldBufferId,
      resourceKey: identity.resourceKey,
      scalarBufferKey: identity.scalarBufferKey,
      targetId: "object:a",
    };

    registry.recordSurfaceAdoption({ ...input, ownerId: "surface-owner:a" });
    registry.recordSurfaceAdoption({ ...input, ownerId: "surface-owner:b" });
    expect(registry.snapshot("object:a")).toHaveLength(1);
    const sequence = registry.snapshot("object:a")[0]?.adoptionSequence;

    registry.clearAdoption("surface-owner:a", identity);
    expect(registry.snapshot("object:a")).toHaveLength(1);
    expect(registry.snapshot("object:a")[0]?.adoptionSequence).toBe(sequence);

    registry.clearAdoption("surface-owner:b", identity);
    expect(registry.snapshot("object:a")).toEqual([]);
  });

  it("restores the same receipt after a StrictMode-style owner release and replay", () => {
    let adoptedAtMs = 1_000;
    const registry = createViewport3DRenderAdoptionRegistry({
      now: () => adoptedAtMs,
    });
    registry.retainDemand("object:a");
    const identity = {
      carrierId: "part:a",
      fieldBufferId: "field-a",
      kind: "vector" as const,
      resourceKey: "resource-a",
      scalarBufferKey: null,
      vectorBuildKey: "vector-a",
    };
    const record = () => registry.recordVectorAdoption({
      byteLength: 48,
      carrierId: identity.carrierId,
      fieldBufferId: identity.fieldBufferId,
      itemCount: 4,
      ownerId: "vector-owner:stable",
      resourceKey: identity.resourceKey,
      targetId: "object:a",
      vectorBuildKey: identity.vectorBuildKey,
    });

    record();
    expect(registry.snapshot("object:a")[0]).toMatchObject({
      adoptedAtMs: 1_000,
      adoptionSequence: 1,
    });
    registry.clearAdoption("vector-owner:stable", identity);
    expect(registry.snapshot("object:a")).toEqual([]);

    adoptedAtMs = 2_000;
    record();
    expect(registry.snapshot("object:a")[0]).toMatchObject({
      adoptedAtMs: 1_000,
      adoptionSequence: 1,
    });
  });

  it("rejects a seventeenth active pass for one target without evicting the first", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    const release = registry.retainDemand("object:a");
    for (let index = 0; index < 17; index += 1) {
      registry.recordSurfaceAdoption({
        byteLength: 12,
        carrierId: `part:${index}`,
        fieldBufferId: `field:${index}`,
        ownerId: `owner:${index}`,
        scalarBufferKey: `scalar:${index}`,
        targetId: "object:a",
      });
    }

    expect(registry.snapshot("object:a")).toHaveLength(16);
    expect(registry.snapshot("object:a")[0]?.carrierId).toBe("part:0");
    expect(registry.snapshot("object:a").some((item) => item.carrierId === "part:16")).toBe(false);
    expect(registry.getLifecycleStats()).toMatchObject({
      activeOwnerCount: 16,
      activePassCount: 16,
      rejectedAdoptionCount: 1,
      rejectedTargetPassCount: 1,
      targetReceiptCount: 16,
    });

    release();
    expect(registry.getLifecycleStats().rejectedTargetPassCount).toBe(0);
  });

  it("clears rejected target-pass state when the last demand is released", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    const release = registry.retainDemand("object:a");
    for (let index = 0; index < 17; index += 1) {
      registry.recordSurfaceAdoption({
        byteLength: 12,
        carrierId: `part:${index}`,
        fieldBufferId: `field:${index}`,
        ownerId: `owner:${index}`,
        scalarBufferKey: `scalar:${index}`,
        targetId: "object:a",
      });
    }
    expect(registry.getLifecycleStats().rejectedTargetPassCount).toBe(1);

    release();

    expect(registry.getLifecycleStats().rejectedTargetPassCount).toBe(0);
  });

  it("rejects a new global pass at the active cap but keeps identical replay stable", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    for (let index = 0; index < 129; index += 1) {
      const targetId = `object:${index}`;
      registry.retainDemand(targetId);
      registry.recordVectorAdoption({
        byteLength: 24,
        carrierId: `part:${index}`,
        fieldBufferId: `field:${index}`,
        ownerId: `owner:${index}`,
        targetId,
        vectorBuildKey: `vector:${index}`,
      });
    }
    const first = registry.snapshot("object:0")[0];
    expect(first).toBeDefined();
    expect(registry.snapshot("object:128")).toEqual([]);

    registry.recordVectorAdoption({
      byteLength: 24,
      carrierId: "part:0",
      fieldBufferId: "field:0",
      ownerId: "owner:0",
      targetId: "object:0",
      vectorBuildKey: "vector:0",
    });
    expect(registry.snapshot("object:0")[0]).toMatchObject({
      adoptedAtMs: first?.adoptedAtMs,
      adoptionSequence: first?.adoptionSequence,
    });
    expect(registry.getLifecycleStats()).toMatchObject({
      activeOwnerCount: 128,
      activePassCount: 128,
      rejectedAdoptionCount: 1,
      targetReceiptCount: 128,
    });
  });

  it("rejects a new owner at the active cap without releasing identical active owners", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.retainDemand("object:a");
    for (let index = 0; index < 129; index += 1) {
      registry.recordSurfaceAdoption({
        byteLength: 12,
        carrierId: "part:a",
        fieldBufferId: "field:a",
        ownerId: `owner:${index}`,
        scalarBufferKey: "scalar:a",
        targetId: "object:a",
      });
    }

    expect(registry.snapshot("object:a")).toHaveLength(1);
    expect(registry.getLifecycleStats()).toMatchObject({
      activeOwnerCount: 128,
      activePassCount: 1,
      rejectedAdoptionCount: 1,
      targetReceiptCount: 1,
    });
  });

  it("bounds inactive StrictMode history after more than 128 released payloads", () => {
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.retainDemand("object:a");
    for (let index = 0; index < 160; index += 1) {
      const identity = {
        carrierId: "part:a",
        fieldBufferId: `field:${index}`,
        kind: "surface" as const,
        resourceKey: `resource:${index}`,
        scalarBufferKey: `scalar:${index}`,
        vectorBuildKey: null,
      };
      registry.recordSurfaceAdoption({
        byteLength: 12,
        carrierId: identity.carrierId,
        fieldBufferId: identity.fieldBufferId,
        ownerId: "owner:stable",
        resourceKey: identity.resourceKey,
        scalarBufferKey: identity.scalarBufferKey,
        targetId: "object:a",
      });
      registry.clearAdoption("owner:stable", identity);
    }

    expect(registry.snapshot("object:a")).toEqual([]);
    expect(registry.getLifecycleStats()).toMatchObject({
      activeOwnerCount: 0,
      activePassCount: 0,
      inactiveHistoryCount: 128,
      rejectedAdoptionCount: 0,
      targetReceiptCount: 0,
    });
  });
});
