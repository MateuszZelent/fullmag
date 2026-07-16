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
    const registry = createViewport3DRenderAdoptionRegistry();
    registry.setCarrierTargets(new Map([["part:a", ["object:a"]]]));
    const replay = vi.fn(() => {
      registry.recordVectorAdoption({
        byteLength: 64,
        carrierId: "part:a",
        fieldBufferId: "field-visible",
        vectorBuildKey: "vector-visible",
      });
    });
    const unregister = registry.registerCarrierAdoptionReplay("part:a", replay);

    expect(registry.snapshot("object:a")).toEqual([]);
    const release = registry.retainDemand("object:a");

    expect(replay).toHaveBeenCalledTimes(1);
    expect(registry.snapshot("object:a")[0]).toMatchObject({
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
});
