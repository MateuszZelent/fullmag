import type { VisualizationDebugSnapshot } from "./visualizationDebugTypes";

export interface VisualizationDebugDemand {
  expanded: boolean;
  targetId: string;
}

export interface VisualizationDebugPublisherToken {
  generation: number;
  viewportId: string;
}

export interface VisualizationDebugLifecycleStats {
  activeDemandCount: number;
  activePublisherCount: number;
  demandedTargetCount: number;
  retainedSnapshotCount: number;
}

type Listener = () => void;

interface PublishedSnapshot {
  generation: number;
  order: number;
  snapshot: VisualizationDebugSnapshot;
  viewportId: string;
}

interface TargetSnapshots {
  lastChangedOrder: number;
  published: PublishedSnapshot[];
  snapshot: readonly VisualizationDebugSnapshot[];
}

export const MAX_VISUALIZATION_DEBUG_TARGETS = 8;
export const MAX_VISUALIZATION_DEBUG_VIEWPORTS_PER_TARGET = 2;
export const MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES = 64 * 1024;

export const EMPTY_VISUALIZATION_DEBUG_SNAPSHOTS: readonly VisualizationDebugSnapshot[] =
  Object.freeze([]);

const textEncoder = new TextEncoder();

export class VisualizationDebugController {
  private readonly activePublisherGenerations = new Map<string, number>();
  private readonly demandCounts = new Map<string, number>();
  private readonly demandListeners = new Map<string, Set<Listener>>();
  private readonly demandSnapshots = new Map<string, VisualizationDebugDemand>();
  private order = 0;
  private publisherGeneration = 0;
  private readonly snapshotListeners = new Map<string, Set<Listener>>();
  private readonly targets = new Map<string, TargetSnapshots>();

  clearPublisher(token: VisualizationDebugPublisherToken): void {
    if (!this.isCurrentPublisher(token)) return;

    this.activePublisherGenerations.delete(token.viewportId);
    this.removeViewportSnapshots(token.viewportId, token.generation);
  }

  commit(
    token: VisualizationDebugPublisherToken,
    targetId: string,
    snapshot: VisualizationDebugSnapshot,
  ): void {
    if (!this.isCurrentPublisher(token)) return;

    const boundedSnapshot = normalizeAndBoundSnapshot(snapshot);
    let target = this.targets.get(targetId);
    if (!target) {
      if (!this.ensureTargetCapacity()) return;
      target = {
        lastChangedOrder: ++this.order,
        published: [],
        snapshot: EMPTY_VISUALIZATION_DEBUG_SNAPSHOTS,
      };
      this.targets.set(targetId, target);
    }

    const existingIndex = target.published.findIndex(
      (entry) => entry.viewportId === token.viewportId,
    );
    const existing = target.published[existingIndex];
    if (existing && snapshotsSemanticallyEqual(existing.snapshot, boundedSnapshot)) {
      existing.generation = token.generation;
      return;
    }

    if (existingIndex >= 0) target.published.splice(existingIndex, 1);
    target.published.push({
      generation: token.generation,
      order: ++this.order,
      snapshot: boundedSnapshot,
      viewportId: token.viewportId,
    });
    target.published.sort((left, right) => left.order - right.order);
    while (
      target.published.length > MAX_VISUALIZATION_DEBUG_VIEWPORTS_PER_TARGET
    ) {
      target.published.shift();
    }
    target.lastChangedOrder = this.order;
    target.snapshot = Object.freeze(
      target.published.map((entry) => entry.snapshot),
    );
    this.notify(this.snapshotListeners.get(targetId));
  }

  getDemandSnapshot(targetId: string): VisualizationDebugDemand {
    const cached = this.demandSnapshots.get(targetId);
    if (cached) return cached;

    const snapshot = frozenDemand(targetId, false);
    this.demandSnapshots.set(targetId, snapshot);
    return snapshot;
  }

  getSnapshots(targetId: string): readonly VisualizationDebugSnapshot[] {
    return this.targets.get(targetId)?.snapshot ?? EMPTY_VISUALIZATION_DEBUG_SNAPSHOTS;
  }

  getLifecycleStats(): VisualizationDebugLifecycleStats {
    let activeDemandCount = 0;
    for (const count of this.demandCounts.values()) activeDemandCount += count;
    let retainedSnapshotCount = 0;
    for (const target of this.targets.values()) {
      retainedSnapshotCount += target.published.length;
    }
    return {
      activeDemandCount,
      activePublisherCount: this.activePublisherGenerations.size,
      demandedTargetCount: this.demandCounts.size,
      retainedSnapshotCount,
    };
  }

  registerPublisher(viewportId: string): VisualizationDebugPublisherToken {
    const generation = ++this.publisherGeneration;
    this.activePublisherGenerations.set(viewportId, generation);
    this.removeViewportSnapshots(viewportId);
    return Object.freeze({ generation, viewportId });
  }

  request(targetId: string): () => void {
    const previousCount = this.demandCounts.get(targetId) ?? 0;
    this.demandCounts.set(targetId, previousCount + 1);
    if (previousCount === 0) {
      this.demandSnapshots.set(targetId, frozenDemand(targetId, true));
      this.notify(this.demandListeners.get(targetId));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const count = this.demandCounts.get(targetId) ?? 0;
      if (count > 1) {
        this.demandCounts.set(targetId, count - 1);
        return;
      }

      this.demandCounts.delete(targetId);
      this.demandSnapshots.set(targetId, frozenDemand(targetId, false));
      this.notify(this.demandListeners.get(targetId));
      this.clearTargetSnapshots(targetId);
      this.pruneDemandSnapshot(targetId);
    };
  }

  subscribe(targetId: string, listener: Listener): () => void {
    const listeners = getOrCreateListeners(this.snapshotListeners, targetId);
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.snapshotListeners.delete(targetId);
    };
  }

  subscribeDemand(targetId: string, listener: Listener): () => void {
    const listeners = getOrCreateListeners(this.demandListeners, targetId);
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.demandListeners.delete(targetId);
      this.pruneDemandSnapshot(targetId);
    };
  }

  private clearTargetSnapshots(targetId: string): void {
    if (!this.targets.delete(targetId)) return;
    this.notify(this.snapshotListeners.get(targetId));
  }

  private ensureTargetCapacity(): boolean {
    if (this.targets.size < MAX_VISUALIZATION_DEBUG_TARGETS) return true;

    let eviction: [string, TargetSnapshots] | null = null;
    for (const entry of this.targets.entries()) {
      if ((this.demandCounts.get(entry[0]) ?? 0) > 0) continue;
      if (!eviction || entry[1].lastChangedOrder < eviction[1].lastChangedOrder) {
        eviction = entry;
      }
    }
    if (!eviction) return false;

    this.targets.delete(eviction[0]);
    this.notify(this.snapshotListeners.get(eviction[0]));
    return true;
  }

  private isCurrentPublisher(token: VisualizationDebugPublisherToken): boolean {
    return this.activePublisherGenerations.get(token.viewportId) === token.generation;
  }

  private notify(listeners: Set<Listener> | undefined): void {
    if (!listeners) return;
    for (const listener of [...listeners]) listener();
  }

  private pruneDemandSnapshot(targetId: string): void {
    if ((this.demandCounts.get(targetId) ?? 0) > 0) return;
    if ((this.demandListeners.get(targetId)?.size ?? 0) > 0) return;
    this.demandSnapshots.delete(targetId);
  }

  private removeViewportSnapshots(
    viewportId: string,
    generation?: number,
  ): void {
    for (const [targetId, target] of [...this.targets.entries()]) {
      const next = target.published.filter(
        (entry) =>
          entry.viewportId !== viewportId ||
          (generation !== undefined && entry.generation !== generation),
      );
      if (next.length === target.published.length) continue;

      if (next.length === 0) {
        this.targets.delete(targetId);
      } else {
        target.published = next;
        target.lastChangedOrder = ++this.order;
        target.snapshot = Object.freeze(next.map((entry) => entry.snapshot));
      }
      this.notify(this.snapshotListeners.get(targetId));
    }
  }
}

function normalizeAndBoundSnapshot(
  snapshot: VisualizationDebugSnapshot,
): VisualizationDebugSnapshot {
  const normalized = normalizeJsonData(
    snapshot,
    "snapshot",
    new WeakSet<object>(),
  ) as VisualizationDebugSnapshot;
  const byteLength = serializedByteLength(normalized);
  if (byteLength <= MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES) return normalized;

  const fallback = normalizeJsonData(
    sizeLimitSnapshot(normalized, byteLength),
    "snapshot-size-limit",
    new WeakSet<object>(),
  ) as VisualizationDebugSnapshot;
  if (serializedByteLength(fallback) > MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES) {
    throw new TypeError(
      "Visualization debug snapshot-size-limit evidence is not JSON-safe and bounded.",
    );
  }
  return fallback;
}

function normalizeJsonData(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): unknown {
  if (value === null) return null;

  const valueType = typeof value;
  if (
    valueType === "undefined" ||
    valueType === "function" ||
    valueType === "symbol" ||
    valueType === "bigint"
  ) {
    throw new TypeError(
      `Visualization debug snapshots must contain only JSON-safe values; ${path} is ${valueType}.`,
    );
  }
  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `Visualization debug snapshots must contain only finite JSON-safe numbers; ${path} is non-finite.`,
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (valueType !== "object") return value;

  const objectValue = value as object;
  if (ArrayBuffer.isView(objectValue)) {
    throw new TypeError(
      `Visualization debug snapshots must not contain typed arrays at ${path}.`,
    );
  }
  if (objectValue instanceof ArrayBuffer) {
    throw new TypeError(
      `Visualization debug snapshots must not contain ArrayBuffers at ${path}.`,
    );
  }
  if (ancestors.has(objectValue)) {
    throw new TypeError(
      `Visualization debug snapshots must be acyclic JSON-safe data; cycle at ${path}.`,
    );
  }

  ancestors.add(objectValue);
  try {
    return Array.isArray(objectValue)
      ? normalizeJsonArray(objectValue, path, ancestors)
      : normalizeJsonObject(objectValue, path, ancestors);
  } finally {
    ancestors.delete(objectValue);
  }
}

function normalizeJsonArray(
  value: unknown[],
  path: string,
  ancestors: WeakSet<object>,
): readonly unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(
      `Visualization debug snapshots must not contain custom array prototypes at ${path}; JSON-safe data only.`,
    );
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<{ descriptor: PropertyDescriptor; index: number }> = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      throw new TypeError(
        `Visualization debug snapshots must not contain symbol-keyed data at ${path}; JSON-safe data only.`,
      );
    }
    if (key === "length") continue;
    if (key === "toJSON") {
      throw new TypeError(
        `Visualization debug snapshots must not contain custom toJSON serialization at ${path}.`,
      );
    }

    const index = canonicalArrayIndex(key);
    if (index === null || index >= value.length) {
      throw new TypeError(
        `Visualization debug arrays must contain only JSON-safe indexed data; unexpected ${path}.${key}.`,
      );
    }
    const descriptor = descriptors[key];
    assertJsonDataDescriptor(descriptor, `${path}[${index}]`);
    entries.push({ descriptor, index });
  }
  if (entries.length !== value.length) {
    throw new TypeError(
      `Visualization debug snapshots must not contain sparse arrays at ${path}; JSON-safe dense data only.`,
    );
  }

  entries.sort((left, right) => left.index - right.index);
  const normalized: unknown[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.index !== index) {
      throw new TypeError(
        `Visualization debug snapshots must not contain sparse arrays at ${path}; JSON-safe dense data only.`,
      );
    }
    normalized.push(
      normalizeJsonData(entry.descriptor.value, `${path}[${index}]`, ancestors),
    );
  }
  return Object.freeze(normalized);
}

function normalizeJsonObject(
  value: object,
  path: string,
  ancestors: WeakSet<object>,
): Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(
      `Visualization debug snapshots must not contain custom prototypes at ${path}; JSON-safe plain data only.`,
    );
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const normalized: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      throw new TypeError(
        `Visualization debug snapshots must not contain symbol-keyed data at ${path}; JSON-safe data only.`,
      );
    }
    if (key === "toJSON") {
      throw new TypeError(
        `Visualization debug snapshots must not contain custom toJSON serialization at ${path}.`,
      );
    }

    const descriptor = descriptors[key];
    assertJsonDataDescriptor(descriptor, `${path}.${key}`);
    Object.defineProperty(normalized, key, {
      configurable: false,
      enumerable: true,
      value: normalizeJsonData(descriptor.value, `${path}.${key}`, ancestors),
      writable: false,
    });
  }
  return Object.freeze(normalized);
}

function assertJsonDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
  path: string,
): asserts descriptor is PropertyDescriptor & { value: unknown } {
  if (!descriptor || "get" in descriptor || "set" in descriptor) {
    throw new TypeError(
      `Visualization debug snapshots must not contain accessors at ${path}; JSON-safe data properties only.`,
    );
  }
  if (!descriptor.enumerable) {
    throw new TypeError(
      `Visualization debug snapshots must not contain non-enumerable hidden state at ${path}; JSON-safe data only.`,
    );
  }
}

function canonicalArrayIndex(key: string): number | null {
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === key
    ? index
    : null;
}

function frozenDemand(
  targetId: string,
  expanded: boolean,
): VisualizationDebugDemand {
  return Object.freeze({ expanded, targetId });
}

function getOrCreateListeners(
  registry: Map<string, Set<Listener>>,
  targetId: string,
): Set<Listener> {
  const existing = registry.get(targetId);
  if (existing) return existing;
  const listeners = new Set<Listener>();
  registry.set(targetId, listeners);
  return listeners;
}

function semanticValueEquals(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((entry, index) => semanticValueEquals(entry, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      semanticValueEquals(leftRecord[key], rightRecord[key]),
  );
}

function snapshotsSemanticallyEqual(
  left: VisualizationDebugSnapshot,
  right: VisualizationDebugSnapshot,
): boolean {
  if (left === right) return true;
  return (Object.keys(left) as Array<keyof VisualizationDebugSnapshot>).every(
    (key) =>
      key === "capturedAtMs" || semanticValueEquals(left[key], right[key]),
  );
}

function serializedByteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function sizeLimitSnapshot(
  snapshot: VisualizationDebugSnapshot,
  byteLength: number,
): VisualizationDebugSnapshot {
  return {
    capturedAtMs: snapshot.capturedAtMs,
    carriers: [],
    disposition: "blocked",
    issues: [
      {
        code: "snapshot-size-limit",
        evidence: [
          `serialized-byte-length=${byteLength}`,
          `limit-byte-length=${MAX_VISUALIZATION_DEBUG_SNAPSHOT_BYTES}`,
        ],
        message:
          "Visualization debug evidence exceeded the 64 KiB UTF-8 snapshot limit and was not retained.",
        severity: "error",
        source: "ui-derived",
      },
    ],
    sharedMemory: [],
    target: {
      carrierIds: [],
      id: truncateUtf8(snapshot.target.id, 256),
      kind: snapshot.target.kind,
      label: truncateUtf8(snapshot.target.label, 256),
    },
    viewport: {
      contextLost: snapshot.viewport.contextLost,
      drawingBuffer: snapshot.viewport.drawingBuffer,
      frameCommittedAtMs: snapshot.viewport.frameCommittedAtMs,
      frameCommitId: truncateUtf8(snapshot.viewport.frameCommitId, 256),
      viewportId: truncateUtf8(snapshot.viewport.viewportId, 256),
    },
    version: 1,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (textEncoder.encode(value).byteLength <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = textEncoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
