import { removeFrontendResourceBucket, updateFrontendResourceBucket } from "./frontendResourceManager";

export interface ViewportResourceRecord {
  key: string;
  owner: string;
  label: string;
  estimatedBytes: number;
  createdAt: number;
  updatedAt: number;
}

export interface ViewportResourceManagerStats {
  entries: number;
  estimatedBytes: number;
  created: number;
  disposed: number;
  replaced: number;
}

interface InternalViewportResourceRecord extends ViewportResourceRecord {
  resource: unknown;
  dispose: () => void;
}

const VIEWPORT_RESOURCE_BUCKET_ID = "viewport-resource-manager";
const VIEWPORT_RESOURCE_BUCKET_LABEL = "Viewport Resource Manager";
const records = new Map<string, InternalViewportResourceRecord>();
const lifecycleStats = {
  created: 0,
  disposed: 0,
  replaced: 0,
};

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function publishStats(): void {
  let estimatedBytes = 0;
  for (const record of records.values()) {
    estimatedBytes += record.estimatedBytes;
  }
  if (records.size === 0) {
    removeFrontendResourceBucket(VIEWPORT_RESOURCE_BUCKET_ID);
    return;
  }
  updateFrontendResourceBucket({
    id: VIEWPORT_RESOURCE_BUCKET_ID,
    label: VIEWPORT_RESOURCE_BUCKET_LABEL,
    entries: records.size,
    estimatedBytes,
  });
}

function disposeRecord(record: InternalViewportResourceRecord): void {
  try {
    record.dispose();
  } finally {
    lifecycleStats.disposed += 1;
  }
}

export function trackViewportResource(args: {
  key: string;
  owner: string;
  label: string;
  resource: unknown;
  estimatedBytes: number;
  dispose: () => void;
}): void {
  const previous = records.get(args.key);
  const estimatedBytes = Math.max(0, Math.trunc(args.estimatedBytes));
  const timestamp = now();

  if (previous && previous.resource === args.resource) {
    records.set(args.key, {
      key: previous.key,
      owner: args.owner,
      label: args.label,
      resource: previous.resource,
      estimatedBytes,
      createdAt: previous.createdAt,
      updatedAt: timestamp,
      dispose: args.dispose,
    });
    publishStats();
    return;
  }

  if (previous) {
    records.delete(args.key);
    lifecycleStats.replaced += 1;
    disposeRecord(previous);
  }

  records.set(args.key, {
    key: args.key,
    owner: args.owner,
    label: args.label,
    resource: args.resource,
    estimatedBytes,
    dispose: args.dispose,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  lifecycleStats.created += 1;
  publishStats();
}

export function releaseViewportResource(key: string): void {
  const record = records.get(key);
  if (!record) return;
  records.delete(key);
  disposeRecord(record);
  publishStats();
}

export function releaseViewportResourcesByOwner(owner: string): void {
  for (const record of Array.from(records.values())) {
    if (record.owner === owner) {
      releaseViewportResource(record.key);
    }
  }
}

export function getViewportResourceRecords(): ViewportResourceRecord[] {
  return Array.from(records.values()).map(({ key, owner, label, estimatedBytes, createdAt, updatedAt }) => ({
    key,
    owner,
    label,
    estimatedBytes,
    createdAt,
    updatedAt,
  }));
}

export function getViewportResourceManagerStats(): ViewportResourceManagerStats {
  let estimatedBytes = 0;
  for (const record of records.values()) {
    estimatedBytes += record.estimatedBytes;
  }
  return {
    entries: records.size,
    estimatedBytes,
    created: lifecycleStats.created,
    disposed: lifecycleStats.disposed,
    replaced: lifecycleStats.replaced,
  };
}

export function estimateThreeBufferAttributeBytes(attribute: unknown): number {
  if (!attribute || typeof attribute !== "object") return 0;
  const array = (attribute as { array?: unknown }).array;
  if (ArrayBuffer.isView(array)) return array.byteLength;
  if (array instanceof ArrayBuffer) return array.byteLength;
  return 0;
}

export function estimateThreeBufferGeometryBytes(geometry: unknown): number {
  if (!geometry || typeof geometry !== "object") return 0;
  const candidate = geometry as {
    attributes?: Record<string, unknown>;
    index?: unknown;
    morphAttributes?: Record<string, unknown[]>;
  };
  let total = 0;
  if (candidate.attributes) {
    for (const attribute of Object.values(candidate.attributes)) {
      total += estimateThreeBufferAttributeBytes(attribute);
    }
  }
  total += estimateThreeBufferAttributeBytes(candidate.index);
  if (candidate.morphAttributes) {
    for (const attributes of Object.values(candidate.morphAttributes)) {
      for (const attribute of attributes) {
        total += estimateThreeBufferAttributeBytes(attribute);
      }
    }
  }
  return total;
}

export function resetViewportResourceManagerForTests(): void {
  for (const key of Array.from(records.keys())) {
    releaseViewportResource(key);
  }
  lifecycleStats.created = 0;
  lifecycleStats.disposed = 0;
  lifecycleStats.replaced = 0;
  removeFrontendResourceBucket(VIEWPORT_RESOURCE_BUCKET_ID);
}
