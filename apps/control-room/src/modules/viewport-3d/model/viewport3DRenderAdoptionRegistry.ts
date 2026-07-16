export type Viewport3DRenderAdoptionKind = "surface" | "vector";

export interface Viewport3DRenderAdoptionReceipt {
  byteLength: number;
  carrierId: string;
  fieldBufferId: string | null;
  itemCount?: number;
  kind: Viewport3DRenderAdoptionKind;
  resourceKey: string | null;
  scalarBufferKey: string | null;
  targetId: string;
  vectorBuildKey: string | null;
}

interface SurfaceAdoptionInput {
  byteLength: number;
  carrierId: string;
  fieldBufferId: string | null;
  resourceKey?: string | null;
  scalarBufferKey: string;
  targetId?: string;
}

interface VectorAdoptionInput {
  byteLength: number;
  carrierId: string;
  fieldBufferId: string | null;
  itemCount?: number;
  resourceKey?: string | null;
  targetId?: string;
  vectorBuildKey: string;
}

export interface Viewport3DRenderAdoptionRegistry {
  clearAdoption(
    adoption: Omit<
      Viewport3DRenderAdoptionReceipt,
      "byteLength" | "itemCount" | "targetId"
    >,
  ): void;
  clearTarget(targetId: string): void;
  registerCarrierAdoptionReplay(
    carrierId: string,
    replay: () => void,
  ): () => void;
  recordSurfaceAdoption(input: SurfaceAdoptionInput): void;
  recordVectorAdoption(input: VectorAdoptionInput): void;
  retainDemand(targetId: string): () => void;
  setCarrierTargets(
    targetIdsByCarrierId: ReadonlyMap<string, readonly string[]>,
  ): void;
  snapshot(targetId: string): readonly Viewport3DRenderAdoptionReceipt[];
  subscribe(listener: (targetId: string) => void): () => void;
}

const EMPTY_RECEIPTS: readonly Viewport3DRenderAdoptionReceipt[] = Object.freeze([]);
const EMPTY_TARGET_IDS: readonly string[] = Object.freeze([]);
const MAX_RECEIPTS_PER_TARGET = 16;

export function createViewport3DRenderAdoptionRegistry(): Viewport3DRenderAdoptionRegistry {
  const demandCounts = new Map<string, number>();
  let carrierTargets: ReadonlyMap<string, readonly string[]> = new Map();
  const receipts = new Map<string, readonly Viewport3DRenderAdoptionReceipt[]>();
  const listeners = new Set<(targetId: string) => void>();
  const replaysByCarrier = new Map<string, Set<() => void>>();

  const notify = (targetId: string) => {
    for (const listener of [...listeners]) listener(targetId);
  };
  const record = (receipt: Viewport3DRenderAdoptionReceipt) => {
    if ((demandCounts.get(receipt.targetId) ?? 0) === 0) return;
    const current = receipts.get(receipt.targetId) ?? EMPTY_RECEIPTS;
    const key = receiptKey(receipt);
    const existingIndex = current.findIndex((entry) => receiptKey(entry) === key);
    if (existingIndex >= 0 && receiptsEqual(current[existingIndex], receipt)) return;
    const next = [...current];
    if (existingIndex >= 0) next.splice(existingIndex, 1);
    next.push(Object.freeze(receipt));
    receipts.set(
      receipt.targetId,
      Object.freeze(next.slice(-MAX_RECEIPTS_PER_TARGET)),
    );
    notify(receipt.targetId);
  };
  const replayCarrier = (carrierId: string) => {
    for (const replay of [...(replaysByCarrier.get(carrierId) ?? [])]) replay();
  };
  const carrierHasDemand = (carrierId: string) =>
    (carrierTargets.get(carrierId) ?? EMPTY_TARGET_IDS).some(
      (targetId) => (demandCounts.get(targetId) ?? 0) > 0,
    );

  return {
    clearAdoption(adoption) {
      for (const [targetId, current] of receipts) {
        const next = current.filter(
          (receipt) => !adoptionIdentityEquals(receipt, adoption),
        );
        if (next.length === current.length) continue;
        if (next.length === 0) receipts.delete(targetId);
        else receipts.set(targetId, Object.freeze(next));
        notify(targetId);
      }
    },
    clearTarget(targetId) {
      if (!receipts.delete(targetId)) return;
      notify(targetId);
    },
    registerCarrierAdoptionReplay(carrierId, replay) {
      const replays = replaysByCarrier.get(carrierId) ?? new Set();
      replays.add(replay);
      replaysByCarrier.set(carrierId, replays);
      if (carrierHasDemand(carrierId)) replay();
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        replays.delete(replay);
        if (replays.size === 0) replaysByCarrier.delete(carrierId);
      };
    },
    recordSurfaceAdoption(input) {
      const targetIds = resolveTargetIds(input.targetId, carrierTargets.get(input.carrierId));
      for (const targetId of targetIds) {
        record({
          ...input,
          byteLength: safeByteLength(input.byteLength),
          kind: "surface",
          resourceKey: input.resourceKey ?? null,
          targetId,
          vectorBuildKey: null,
        });
      }
    },
    recordVectorAdoption(input) {
      const targetIds = resolveTargetIds(input.targetId, carrierTargets.get(input.carrierId));
      for (const targetId of targetIds) {
        record({
          ...input,
          byteLength: safeByteLength(input.byteLength),
          ...(input.itemCount === undefined
            ? {}
            : { itemCount: safeCount(input.itemCount) }),
          kind: "vector",
          resourceKey: input.resourceKey ?? null,
          scalarBufferKey: null,
          targetId,
        });
      }
    },
    retainDemand(targetId) {
      demandCounts.set(targetId, (demandCounts.get(targetId) ?? 0) + 1);
      for (const [carrierId, targetIds] of carrierTargets) {
        if (targetIds.includes(targetId)) replayCarrier(carrierId);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = demandCounts.get(targetId) ?? 0;
        if (count > 1) {
          demandCounts.set(targetId, count - 1);
          return;
        }
        demandCounts.delete(targetId);
        if (receipts.delete(targetId)) notify(targetId);
      };
    },
    snapshot(targetId) {
      return receipts.get(targetId) ?? EMPTY_RECEIPTS;
    },
    setCarrierTargets(targetIdsByCarrierId) {
      carrierTargets = new Map(
        [...targetIdsByCarrierId].map(([carrierId, targetIds]) => [
          carrierId,
          Object.freeze([...new Set(targetIds)]),
        ]),
      );
      for (const carrierId of carrierTargets.keys()) {
        if (carrierHasDemand(carrierId)) replayCarrier(carrierId);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
  };
}

function resolveTargetIds(
  explicitTargetId: string | undefined,
  mappedTargetIds: readonly string[] | undefined,
): readonly string[] {
  return explicitTargetId ? [explicitTargetId] : (mappedTargetIds ?? EMPTY_TARGET_IDS);
}

function safeByteLength(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function receiptKey(receipt: Viewport3DRenderAdoptionReceipt): string {
  return `${receipt.kind}\u0000${receipt.carrierId}`;
}

function receiptsEqual(
  left: Viewport3DRenderAdoptionReceipt | undefined,
  right: Viewport3DRenderAdoptionReceipt,
): boolean {
  return Boolean(
    left &&
      left.byteLength === right.byteLength &&
      left.carrierId === right.carrierId &&
      left.fieldBufferId === right.fieldBufferId &&
      left.itemCount === right.itemCount &&
      left.kind === right.kind &&
      left.resourceKey === right.resourceKey &&
      left.scalarBufferKey === right.scalarBufferKey &&
      left.targetId === right.targetId &&
      left.vectorBuildKey === right.vectorBuildKey,
  );
}

function adoptionIdentityEquals(
  receipt: Viewport3DRenderAdoptionReceipt,
  adoption: Omit<
    Viewport3DRenderAdoptionReceipt,
    "byteLength" | "itemCount" | "targetId"
  >,
): boolean {
  return (
    receipt.carrierId === adoption.carrierId &&
    receipt.fieldBufferId === adoption.fieldBufferId &&
    receipt.kind === adoption.kind &&
    receipt.resourceKey === adoption.resourceKey &&
    receipt.scalarBufferKey === adoption.scalarBufferKey &&
    receipt.vectorBuildKey === adoption.vectorBuildKey
  );
}
