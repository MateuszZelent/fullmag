export type Viewport3DRenderAdoptionKind = "surface" | "vector";

export interface Viewport3DRenderAdoptionReceipt {
  adoptedAtMs: number;
  adoptionSequence: number;
  byteLength: number;
  carrierId: string;
  fieldBufferId: string | null;
  itemCount?: number;
  kind: Viewport3DRenderAdoptionKind;
  resourceKey: string | null;
  sessionEpoch: string;
  sessionId: string;
  scalarBufferKey: string | null;
  targetId: string;
  vectorBuildKey: string | null;
}

export type Viewport3DRenderAdoptionIdentity = Omit<
  Viewport3DRenderAdoptionReceipt,
  | "adoptedAtMs"
  | "adoptionSequence"
  | "byteLength"
  | "itemCount"
  | "sessionEpoch"
  | "sessionId"
  | "targetId"
> & Partial<Pick<Viewport3DRenderAdoptionReceipt, "sessionEpoch" | "sessionId">>;

interface SurfaceAdoptionInput {
  byteLength: number;
  carrierId: string;
  fieldBufferId: string | null;
  ownerId?: string;
  resourceKey?: string | null;
  sessionIdentity?: { sessionEpoch: string; sessionId: string } | null;
  scalarBufferKey: string;
  targetId?: string;
}

interface VectorAdoptionInput {
  byteLength: number;
  carrierId: string;
  fieldBufferId: string | null;
  itemCount?: number;
  ownerId?: string;
  resourceKey?: string | null;
  sessionIdentity?: { sessionEpoch: string; sessionId: string } | null;
  targetId?: string;
  vectorBuildKey: string;
}

export type Viewport3DRenderAdoptionResult =
  | { status: "adopted" }
  | {
      reason:
        | "adoption-capacity-exhausted"
        | "missing-session-identity"
        | "session-identity-mismatch";
      status: "unavailable";
    };

type AdoptionPass = Omit<Viewport3DRenderAdoptionReceipt, "targetId">;
type AdoptionInput = Omit<
  Viewport3DRenderAdoptionReceipt,
  "adoptedAtMs" | "adoptionSequence" | "sessionEpoch" | "sessionId" | "targetId"
> & {
  sessionIdentity?: { sessionEpoch: string; sessionId: string } | null;
};

interface OwnedAdoption {
  explicitTargetId: string | null;
  ownerId: string;
  receipt: AdoptionPass;
}

export interface Viewport3DRenderAdoptionRegistryLifecycleStats {
  activeOwnerCount: number;
  activePassCount: number;
  inactiveHistoryCount: number;
  rejectedAdoptionCount: number;
  rejectedTargetPassCount: number;
  targetReceiptCount: number;
}

export interface Viewport3DRenderAdoptionRegistry {
  clearAdoption(adoption: Viewport3DRenderAdoptionIdentity): void;
  clearAdoption(
    ownerId: string,
    adoption: Viewport3DRenderAdoptionIdentity,
  ): void;
  clearTarget(targetId: string): void;
  getLifecycleStats(): Viewport3DRenderAdoptionRegistryLifecycleStats;
  latestActiveAdoption(input: {
    sessionEpoch: string;
    sessionId: string;
  }): Viewport3DRenderAdoptionReceipt | null;
  hasActiveAdoption(input: {
    fieldBufferId: string;
    resourceKey: string | null;
    sessionEpoch: string;
    sessionId: string;
  }): boolean;
  registerCarrierAdoptionReplay(
    carrierId: string,
    replay: () => void,
  ): () => void;
  recordSurfaceAdoption(input: SurfaceAdoptionInput): Viewport3DRenderAdoptionResult;
  recordVectorAdoption(input: VectorAdoptionInput): Viewport3DRenderAdoptionResult;
  retainDemand(targetId: string): () => void;
  setSessionIdentity(identity: { sessionEpoch: string; sessionId: string } | null): void;
  setCarrierTargets(
    targetIdsByCarrierId: ReadonlyMap<string, readonly string[]>,
  ): void;
  snapshot(targetId: string): readonly Viewport3DRenderAdoptionReceipt[];
  subscribeActive(listener: () => void): () => void;
  subscribe(listener: (targetId: string) => void): () => void;
}

const EMPTY_RECEIPTS: readonly Viewport3DRenderAdoptionReceipt[] = Object.freeze([]);
const EMPTY_TARGET_IDS: readonly string[] = Object.freeze([]);
const MAX_RECEIPTS_PER_TARGET = 16;
const MAX_ACTIVE_ADOPTED_PASSES = 128;
const MAX_INACTIVE_ADOPTION_HISTORY = 128;
const MAX_REJECTED_TARGET_PASSES = 128;

export function createViewport3DRenderAdoptionRegistry({
  now = Date.now,
}: {
  now?: () => number;
} = {}): Viewport3DRenderAdoptionRegistry {
  const demandCounts = new Map<string, number>();
  let carrierTargets: ReadonlyMap<string, readonly string[]> = new Map();
  const receipts = new Map<string, readonly Viewport3DRenderAdoptionReceipt[]>();
  const activePasses = new Map<string, Map<string, OwnedAdoption>>();
  const inactiveHistory = new Map<string, AdoptionPass>();
  const listeners = new Set<(targetId: string) => void>();
  const activeListeners = new Set<() => void>();
  const replaysByCarrier = new Map<string, Set<() => void>>();
  const rejectedTargetPasses = new Set<string>();
  let adoptionSequence = 0;
  let activeOwnerCount = 0;
  let rejectedAdoptionCount = 0;
  let currentSessionIdentity: { sessionEpoch: string; sessionId: string } | null = null;

  const notify = (targetId: string) => {
    for (const listener of [...listeners]) listener(targetId);
  };
  const notifyActive = () => {
    for (const listener of [...activeListeners]) listener();
  };
  const clearRejectedTargetPasses = (targetId: string) => {
    for (const rejectedKey of [...rejectedTargetPasses]) {
      if (rejectedKey.startsWith(`${targetId}\u0000`)) {
        rejectedTargetPasses.delete(rejectedKey);
      }
    }
  };
  const rememberRejectedTargetPass = (targetId: string, key: string) => {
    const rejectedKey = targetPassKey(targetId, key);
    if (rejectedTargetPasses.has(rejectedKey)) return;
    rejectedTargetPasses.add(rejectedKey);
    rejectedAdoptionCount += 1;
    while (rejectedTargetPasses.size > MAX_REJECTED_TARGET_PASSES) {
      const oldestKey = rejectedTargetPasses.values().next().value;
      if (oldestKey === undefined) break;
      rejectedTargetPasses.delete(oldestKey);
    }
  };
  const ownerTargetIds = (owned: OwnedAdoption): readonly string[] =>
    owned.explicitTargetId
      ? [owned.explicitTargetId]
      : (carrierTargets.get(owned.receipt.carrierId) ?? EMPTY_TARGET_IDS);
  const removeReceipt = (targetId: string, key: string) => {
    const current = receipts.get(targetId) ?? EMPTY_RECEIPTS;
    const next = current.filter((receipt) => receiptKey(receipt) !== key);
    rejectedTargetPasses.delete(targetPassKey(targetId, key));
    if (next.length === current.length) return;
    if (next.length === 0) receipts.delete(targetId);
    else receipts.set(targetId, Object.freeze(next));
    notify(targetId);
  };
  const syncPass = (key: string) => {
    const owners = activePasses.get(key);
    const targetIds = new Set<string>();
    for (const [targetId, current] of receipts) {
      if (current.some((receipt) => receiptKey(receipt) === key)) {
        targetIds.add(targetId);
      }
    }
    for (const owned of owners?.values() ?? []) {
      for (const targetId of ownerTargetIds(owned)) targetIds.add(targetId);
    }
    for (const targetId of targetIds) {
      if ((demandCounts.get(targetId) ?? 0) === 0) {
        removeReceipt(targetId, key);
        continue;
      }
      const selected = [...(owners?.values() ?? [])]
        .filter((owned) => ownerTargetIds(owned).includes(targetId))
        .sort((left, right) => right.receipt.adoptionSequence - left.receipt.adoptionSequence)[0];
      if (!selected) {
        removeReceipt(targetId, key);
        continue;
      }
      const current = receipts.get(targetId) ?? EMPTY_RECEIPTS;
      const existingIndex = current.findIndex((receipt) => receiptKey(receipt) === key);
      const nextReceipt = Object.freeze({ ...selected.receipt, targetId });
      if (existingIndex >= 0 && receiptsEqual(current[existingIndex], nextReceipt)) {
        continue;
      }
      if (existingIndex < 0 && current.length >= MAX_RECEIPTS_PER_TARGET) {
        rememberRejectedTargetPass(targetId, key);
        continue;
      }
      const next = [...current];
      if (existingIndex >= 0) next.splice(existingIndex, 1);
      next.push(nextReceipt);
      receipts.set(targetId, Object.freeze(next));
      rejectedTargetPasses.delete(targetPassKey(targetId, key));
      notify(targetId);
    }
  };
  const rememberInactive = (owned: OwnedAdoption) => {
    const key = historyKey(owned.ownerId, owned.receipt);
    inactiveHistory.delete(key);
    inactiveHistory.set(key, owned.receipt);
    while (inactiveHistory.size > MAX_INACTIVE_ADOPTION_HISTORY) {
      const oldestKey = inactiveHistory.keys().next().value;
      if (oldestKey === undefined) break;
      inactiveHistory.delete(oldestKey);
    }
  };
  const adopt = (
    input: AdoptionInput,
    explicitOwnerId: string | undefined,
    explicitTargetId: string | undefined,
  ) => {
    const { sessionIdentity: explicitSessionIdentity = null, ...receiptInput } = input;
    // A receipt is valid only when its producer supplies the session identity
    // that was used to build the buffer. The registry's current identity is
    // only a validation boundary; it must never backfill missing provenance.
    const responseSessionIdentity = explicitSessionIdentity;
    if (
      !responseSessionIdentity?.sessionId?.trim() ||
      !responseSessionIdentity.sessionEpoch?.trim()
    ) {
      rejectedAdoptionCount += 1;
      return {
        reason: "missing-session-identity" as const,
        status: "unavailable" as const,
      };
    }
    if (
      currentSessionIdentity &&
      (!responseSessionIdentity ||
        responseSessionIdentity.sessionId !== currentSessionIdentity.sessionId ||
        responseSessionIdentity.sessionEpoch !== currentSessionIdentity.sessionEpoch)
    ) {
      rejectedAdoptionCount += 1;
      return {
        reason: "session-identity-mismatch" as const,
        status: "unavailable" as const,
      };
    }
    const sessionIdentity = responseSessionIdentity;
    const key = receiptKey(receiptInput);
    const ownerId = explicitOwnerId ?? legacyOwnerId(receiptInput);
    const currentOwners = activePasses.get(key);
    const currentOwner = currentOwners?.get(ownerId);
    if (currentOwner && adoptedPassEquals(currentOwner.receipt, receiptInput)) {
      currentOwner.explicitTargetId = explicitTargetId ?? null;
      syncPass(key);
      return { status: "adopted" as const };
    }
    if (!currentOwners && activePasses.size >= MAX_ACTIVE_ADOPTED_PASSES) {
      rejectedAdoptionCount += 1;
      return { reason: "adoption-capacity-exhausted" as const, status: "unavailable" as const };
    }
    if (!currentOwner && activeOwnerCount >= MAX_ACTIVE_ADOPTED_PASSES) {
      rejectedAdoptionCount += 1;
      return { reason: "adoption-capacity-exhausted" as const, status: "unavailable" as const };
    }
    const resolvedTargetIds = explicitTargetId
      ? [explicitTargetId]
      : (carrierTargets.get(input.carrierId) ?? EMPTY_TARGET_IDS);
    const saturatedTargetIds = !currentOwners
      ? resolvedTargetIds.filter((targetId) =>
          (demandCounts.get(targetId) ?? 0) > 0 &&
          (receipts.get(targetId)?.length ?? 0) >= MAX_RECEIPTS_PER_TARGET,
        )
      : [];
    if (saturatedTargetIds.length > 0) {
      for (const targetId of saturatedTargetIds) {
        rememberRejectedTargetPass(targetId, key);
      }
      return { reason: "adoption-capacity-exhausted" as const, status: "unavailable" as const };
    }
    if (currentOwner) rememberInactive(currentOwner);
    const inactiveKey = historyKey(ownerId, receiptInput);
    const historical = inactiveHistory.get(inactiveKey);
    const matchingActive = [...(currentOwners?.values() ?? [])].find((owned) =>
      adoptedPassEquals(owned.receipt, receiptInput),
    );
    const receipt = matchingActive?.receipt ?? historical ?? Object.freeze({
      ...receiptInput,
      adoptedAtMs: safeTimestamp(now()),
      adoptionSequence: ++adoptionSequence,
      sessionEpoch: sessionIdentity.sessionEpoch,
      sessionId: sessionIdentity.sessionId,
    });
    inactiveHistory.delete(inactiveKey);
    const owners = currentOwners ?? new Map<string, OwnedAdoption>();
    if (!currentOwner) activeOwnerCount += 1;
    owners.set(ownerId, {
      explicitTargetId: explicitTargetId ?? null,
      ownerId,
      receipt,
    });
    activePasses.set(key, owners);
    syncPass(key);
    // Renderer completion cannot depend on an expanded Visualization Debug
    // target. Signal a newly effective WebGL adoption even with zero debug
    // demand so the viewport can invalidate and commit its ACK frame.
    if (!matchingActive) notifyActive();
    return { status: "adopted" as const };
  };
  const replayCarrier = (carrierId: string) => {
    for (const replay of [...(replaysByCarrier.get(carrierId) ?? [])]) replay();
  };
  const carrierHasDemand = (carrierId: string) =>
    (carrierTargets.get(carrierId) ?? EMPTY_TARGET_IDS).some(
      (targetId) => (demandCounts.get(targetId) ?? 0) > 0,
    );

  return {
    clearAdoption(
      ownerOrAdoption: string | Viewport3DRenderAdoptionIdentity,
      maybeAdoption?: Viewport3DRenderAdoptionIdentity,
    ) {
      const adoption = typeof ownerOrAdoption === "string"
        ? maybeAdoption
        : ownerOrAdoption;
      if (!adoption) return;
      const key = receiptKey(adoption);
      const owners = activePasses.get(key);
      const ownerId = typeof ownerOrAdoption === "string"
        ? ownerOrAdoption
        : [...(owners?.entries() ?? [])].find(
            ([candidateOwnerId, candidate]) =>
              candidateOwnerId.startsWith("legacy:") &&
              adoptionIdentityEquals(candidate.receipt, adoption),
          )?.[0];
      if (!ownerId) return;
      const owned = owners?.get(ownerId);
      if (!owners || !owned || !adoptionIdentityEquals(owned.receipt, adoption)) return;
      const selectedBefore = [...owners.values()].sort(
        (left, right) => right.receipt.adoptionSequence - left.receipt.adoptionSequence,
      )[0]?.receipt;
      owners.delete(ownerId);
      activeOwnerCount -= 1;
      rememberInactive(owned);
      if (owners.size === 0) activePasses.delete(key);
      syncPass(key);
      const selectedAfter = [...owners.values()].sort(
        (left, right) => right.receipt.adoptionSequence - left.receipt.adoptionSequence,
      )[0]?.receipt;
      if (selectedBefore !== selectedAfter) notifyActive();
    },
    clearTarget(targetId) {
      const hadReceipts = receipts.delete(targetId);
      clearRejectedTargetPasses(targetId);
      if (hadReceipts) notify(targetId);
    },
    getLifecycleStats() {
      let targetReceiptCount = 0;
      for (const targetReceipts of receipts.values()) targetReceiptCount += targetReceipts.length;
      return {
        activeOwnerCount,
        activePassCount: activePasses.size,
        inactiveHistoryCount: inactiveHistory.size,
        rejectedAdoptionCount,
        rejectedTargetPassCount: rejectedTargetPasses.size,
        targetReceiptCount,
      };
    },
    latestActiveAdoption({ sessionEpoch, sessionId }) {
      let latest: Viewport3DRenderAdoptionReceipt | null = null;
      for (const owners of activePasses.values()) {
        for (const owned of owners.values()) {
          const receipt = owned.receipt;
          if (
            receipt.sessionEpoch !== sessionEpoch ||
            receipt.sessionId !== sessionId ||
            !receipt.fieldBufferId ||
            !receipt.resourceKey
          ) {
            continue;
          }
          if (!latest || receipt.adoptionSequence > latest.adoptionSequence) {
            latest = {
              ...receipt,
              targetId:
                ownerTargetIds(owned)[0] ??
                owned.explicitTargetId ??
                receipt.carrierId,
            };
          }
        }
      }
      return latest;
    },
    hasActiveAdoption({ fieldBufferId, resourceKey, sessionEpoch, sessionId }) {
      for (const owners of activePasses.values()) {
        for (const owned of owners.values()) {
          const receipt = owned.receipt;
          if (
            receipt.fieldBufferId === fieldBufferId &&
            receipt.resourceKey === resourceKey &&
            receipt.sessionEpoch === sessionEpoch &&
            receipt.sessionId === sessionId
          ) {
            return true;
          }
        }
      }
      return false;
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
      return adopt({
        byteLength: safeByteLength(input.byteLength),
        carrierId: input.carrierId,
        fieldBufferId: input.fieldBufferId,
        kind: "surface",
        resourceKey: input.resourceKey ?? null,
        scalarBufferKey: input.scalarBufferKey,
        sessionIdentity: input.sessionIdentity ?? null,
        vectorBuildKey: null,
      }, input.ownerId, input.targetId);
    },
    recordVectorAdoption(input) {
      return adopt({
        byteLength: safeByteLength(input.byteLength),
        carrierId: input.carrierId,
        fieldBufferId: input.fieldBufferId,
        ...(input.itemCount === undefined
          ? {}
          : { itemCount: safeCount(input.itemCount) }),
        kind: "vector",
        resourceKey: input.resourceKey ?? null,
        sessionIdentity: input.sessionIdentity ?? null,
        scalarBufferKey: null,
        vectorBuildKey: input.vectorBuildKey,
      }, input.ownerId, input.targetId);
    },
    retainDemand(targetId) {
      demandCounts.set(targetId, (demandCounts.get(targetId) ?? 0) + 1);
      for (const key of activePasses.keys()) syncPass(key);
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
        const hadReceipts = receipts.delete(targetId);
        clearRejectedTargetPasses(targetId);
        if (hadReceipts) notify(targetId);
      };
    },
    setSessionIdentity(identity) {
      if (
        currentSessionIdentity?.sessionId === identity?.sessionId &&
        currentSessionIdentity?.sessionEpoch === identity?.sessionEpoch
      ) {
        return;
      }
      const affectedTargetIds = [...receipts.keys()];
      const hadActivePasses = activePasses.size > 0;
      currentSessionIdentity = identity;
      receipts.clear();
      activePasses.clear();
      inactiveHistory.clear();
      rejectedTargetPasses.clear();
      activeOwnerCount = 0;
      for (const targetId of affectedTargetIds) notify(targetId);
      if (hadActivePasses) notifyActive();
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
      for (const key of activePasses.keys()) syncPass(key);
      for (const carrierId of carrierTargets.keys()) {
        if (carrierHasDemand(carrierId)) replayCarrier(carrierId);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      for (const targetId of receipts.keys()) listener(targetId);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
    subscribeActive(listener) {
      activeListeners.add(listener);
      // React mounts child layer effects before the parent scene effect.  If
      // the layer adopted its buffer first, replay that active state so the
      // late scene subscriber still invalidates and commits the rendered ACK.
      if (activePasses.size > 0) listener();
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        activeListeners.delete(listener);
      };
    },
  };
}

function safeByteLength(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeTimestamp(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function receiptKey(receipt: Pick<Viewport3DRenderAdoptionReceipt, "carrierId" | "kind">): string {
  return `${receipt.kind}\u0000${receipt.carrierId}`;
}

function targetPassKey(targetId: string, key: string): string {
  return `${targetId}\u0000${key}`;
}

function semanticKey(receipt: AdoptionInput | AdoptionPass | Viewport3DRenderAdoptionIdentity): string {
  return JSON.stringify([
    receipt.carrierId,
    receipt.fieldBufferId,
    receipt.kind,
    receipt.resourceKey,
    receipt.scalarBufferKey,
    receipt.vectorBuildKey,
    "byteLength" in receipt ? receipt.byteLength : null,
    "itemCount" in receipt ? receipt.itemCount ?? null : null,
  ]);
}

function historyKey(
  ownerId: string,
  receipt: AdoptionInput | AdoptionPass | Viewport3DRenderAdoptionIdentity,
): string {
  return `${ownerId}\u0000${semanticKey(receipt)}`;
}

function legacyOwnerId(
  receipt: AdoptionInput | AdoptionPass | Viewport3DRenderAdoptionIdentity,
): string {
  return `legacy:${semanticKey(receipt)}`;
}

function adoptedPassEquals(
  left: AdoptionPass,
  right: AdoptionInput,
): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.carrierId === right.carrierId &&
    left.fieldBufferId === right.fieldBufferId &&
    left.itemCount === right.itemCount &&
    left.kind === right.kind &&
    left.resourceKey === right.resourceKey &&
    left.scalarBufferKey === right.scalarBufferKey &&
    left.vectorBuildKey === right.vectorBuildKey
  );
}

function receiptsEqual(
  left: Viewport3DRenderAdoptionReceipt | undefined,
  right: Viewport3DRenderAdoptionReceipt,
): boolean {
  return Boolean(
    left &&
      left.byteLength === right.byteLength &&
      left.adoptedAtMs === right.adoptedAtMs &&
      left.adoptionSequence === right.adoptionSequence &&
      left.carrierId === right.carrierId &&
      left.fieldBufferId === right.fieldBufferId &&
      left.itemCount === right.itemCount &&
      left.kind === right.kind &&
      left.resourceKey === right.resourceKey &&
      left.sessionEpoch === right.sessionEpoch &&
      left.sessionId === right.sessionId &&
      left.scalarBufferKey === right.scalarBufferKey &&
      left.targetId === right.targetId &&
      left.vectorBuildKey === right.vectorBuildKey,
  );
}

function adoptionIdentityEquals(
  receipt: Pick<
    Viewport3DRenderAdoptionReceipt,
    | "carrierId"
    | "fieldBufferId"
    | "kind"
    | "resourceKey"
    | "sessionEpoch"
    | "sessionId"
    | "scalarBufferKey"
    | "vectorBuildKey"
  >,
  adoption: Viewport3DRenderAdoptionIdentity,
): boolean {
  return (
    receipt.carrierId === adoption.carrierId &&
    receipt.fieldBufferId === adoption.fieldBufferId &&
    receipt.kind === adoption.kind &&
    receipt.resourceKey === adoption.resourceKey &&
    (adoption.sessionEpoch === undefined || receipt.sessionEpoch === adoption.sessionEpoch) &&
    (adoption.sessionId === undefined || receipt.sessionId === adoption.sessionId) &&
    receipt.scalarBufferKey === adoption.scalarBufferKey &&
    receipt.vectorBuildKey === adoption.vectorBuildKey
  );
}
