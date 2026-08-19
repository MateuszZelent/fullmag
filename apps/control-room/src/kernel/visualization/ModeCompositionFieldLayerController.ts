import {
  asDecodedComplexFieldVector,
  type DecodedComplexFieldVector,
  type DecodedFieldVector,
} from "../api/codecs";
import type { FrequencyDomainFieldResource } from "../api/apiTypes";
import { modeFieldComplexBinaryResourceKey, type ModeFieldComplexBinaryIdentity } from "../resources/frequencyDomainResourceKeys";
import { ResourceCache } from "../resources/ResourceCache";

import type { ModeCompositionLayer, ModeCompositionResource } from "./ModeCompositionController";

export type ModeCompositionFieldLayerStatus =
  | "absent"
  | "preparing"
  | "ready"
  | "refreshing"
  | "degraded"
  | "error";

export type ModeCompositionFieldLayerFailureReason =
  | "identity_mismatch"
  | "invalid_layer"
  | "topology_mismatch"
  | "transport_error";

export interface ModeCompositionFieldLayerTopologyIdentity {
  readonly domainGenerationId: string | null;
  readonly meshTopologyHash: string | null;
  readonly meshTopologyRevision: string | null;
}

export interface ModeCompositionFieldLayerSnapshot {
  readonly error: Error | null;
  readonly field: DecodedComplexFieldVector | null;
  readonly identity: ModeFieldComplexBinaryIdentity | null;
  readonly layer: ModeCompositionLayer | null;
  readonly reason: ModeCompositionFieldLayerFailureReason | null;
  readonly status: ModeCompositionFieldLayerStatus;
}

/** Per-target immutable snapshot consumed by the viewport render-plan layer. */
export type ModeCompositionFieldLayerSnapshotMap = ReadonlyMap<
  string,
  ModeCompositionFieldLayerSnapshot
>;

export interface ModeCompositionFieldBinaryLoadResult {
  readonly byteLength: number;
  readonly data: DecodedFieldVector;
  readonly encoding: string | null;
  readonly etag: string | null;
  readonly fieldRevision: string | null;
}

export interface ModeCompositionFieldLayerLoaders {
  loadBinary(
    layer: ModeCompositionLayer,
    signal: AbortSignal,
    etag?: string | null,
  ): Promise<ModeCompositionFieldBinaryLoadResult>;
  loadMetadata(
    layer: ModeCompositionLayer,
    signal: AbortSignal,
  ): Promise<FrequencyDomainFieldResource>;
}

interface ResolvedMetadata {
  readonly metadataRevision: string;
}

interface CachedField {
  readonly field: DecodedComplexFieldVector;
  readonly identity: ModeFieldComplexBinaryIdentity;
}

interface RetainedField extends CachedField {
  readonly layer: ModeCompositionLayer;
  readonly topology: ModeCompositionFieldLayerTopologyIdentity;
}

type Listener = () => void;

const MAX_CACHE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_LOADS = 4;

/**
 * Owns only ephemeral, decoded data-plane state. The composition itself remains
 * server-authoritative; a caller supplies each latest HTTP resource snapshot.
 */
export class ModeCompositionFieldLayerController {
  private abortController: AbortController | null = null;
  private readonly fieldCache = new ResourceCache<CachedField>({
    maxBytes: MAX_CACHE_BYTES,
  });
  private readonly listeners = new Set<Listener>();
  private readonly fieldRevisions = new Map<string, string>();
  private readonly metadataCache = new Map<string, ResolvedMetadata>();
  private readonly metadataInflight = new Map<string, Promise<ResolvedMetadata>>();
  private requestToken = 0;
  private readonly retained = new Map<string, RetainedField>();
  private snapshot: ModeCompositionFieldLayerSnapshotMap = new Map();

  constructor(
    private readonly maxConcurrentLoads = DEFAULT_MAX_CONCURRENT_LOADS,
  ) {}

  getSnapshot(): ModeCompositionFieldLayerSnapshotMap {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.requestToken += 1;
    this.abortController?.abort();
    this.abortController = null;
    this.metadataInflight.clear();
    this.retained.clear();
    this.publish(new Map());
  }

  async activate(
    resource: ModeCompositionResource | null | undefined,
    topologyByTarget: Readonly<Record<string, ModeCompositionFieldLayerTopologyIdentity | null | undefined>>,
    loaders: ModeCompositionFieldLayerLoaders,
  ): Promise<"cancelled" | "completed"> {
    const requestToken = ++this.requestToken;
    this.abortController?.abort();
    this.metadataInflight.clear();
    const abortController = new AbortController();
    this.abortController = abortController;

    const next = new Map<string, ModeCompositionFieldLayerSnapshot>();
    const active: Array<{ layer: ModeCompositionLayer; topology: ModeCompositionFieldLayerTopologyIdentity }> = [];

    if (resource) {
      const layersByTarget = groupLayersByTarget(resource.layers);
      for (const [targetId, layers] of layersByTarget) {
        if (layers.length !== 1) {
          this.retained.delete(targetId);
          next.set(targetId, errorSnapshot(
            layers[0] ?? null,
            `Mode composition has ${layers.length} layers for target '${targetId}'.`,
            "invalid_layer",
          ));
          continue;
        }
        const layer = layers[0]!;
        if (!layer.enabled) {
          this.retained.delete(targetId);
          next.set(targetId, absentSnapshot(layer));
          continue;
        }
        const topology = topologyByTarget[targetId] ?? null;
        const layerError = validateLayer(resource, layer, topology);
        if (layerError) {
          this.retained.delete(targetId);
          next.set(targetId, errorSnapshot(
            layer,
            layerError,
            !topology || !completeTopology(topology)
              ? "topology_mismatch"
              : "invalid_layer",
          ));
          continue;
        }
        const retained = this.retained.get(targetId);
        if (retained && !sameTopology(retained.topology, topology!)) {
          this.retained.delete(targetId);
        }
        const retainedForTopology = this.retained.get(targetId) ?? null;
        next.set(targetId, retainedForTopology
          ? refreshingSnapshot(layer, retainedForTopology)
          : preparingSnapshot(layer));
        active.push({ layer, topology: topology! });
      }
    }

    this.publish(next);
    await runBounded(active, this.maxConcurrentLoads, async ({ layer, topology }) => {
      await this.loadLayer(
        requestToken,
        layer,
        topology,
        loaders,
        abortController.signal,
      );
    });

    if (this.requestToken !== requestToken) return "cancelled";
    if (this.abortController === abortController) this.abortController = null;
    return "completed";
  }

  private async loadLayer(
    requestToken: number,
    layer: ModeCompositionLayer,
    topology: ModeCompositionFieldLayerTopologyIdentity,
    loaders: ModeCompositionFieldLayerLoaders,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const metadata = await this.resolveMetadata(layer, loaders, signal);
      if (!this.isCurrent(requestToken)) return;
      const revisionKey = fieldRevisionKey(layer, topology, metadata);
      const fieldRevision = this.fieldRevisions.get(revisionKey) ?? null;
      const identity = fieldRevision
        ? createFieldIdentity(layer, topology, fieldRevision)
        : null;
      const cached = identity
        ? this.fieldCache.get(modeFieldComplexBinaryResourceKey(identity))
        : null;
      const entry = cached ?? await this.loadAndValidateBinary(
        layer,
        topology,
        identity,
        revisionKey,
        loaders,
        signal,
      );
      if (!this.isCurrent(requestToken)) return;
      const retained: RetainedField = {
        ...entry.data,
        layer,
        topology,
      };
      this.retained.set(layer.target_id, retained);
      this.replace(layer.target_id, {
        error: null,
        field: retained.field,
        identity: retained.identity,
        layer,
        reason: null,
        status: "ready",
      });
    } catch (error) {
      if (!this.isCurrent(requestToken)) return;
      const normalized = normalizeError(error);
      const retained = this.retained.get(layer.target_id);
      if (retained && sameTopology(retained.topology, topology) && !isIdentityError(normalized)) {
        this.replace(layer.target_id, {
          error: normalized,
          field: retained.field,
          identity: retained.identity,
          layer,
          reason: "transport_error",
          status: "degraded",
        });
        return;
      }
      this.retained.delete(layer.target_id);
      this.replace(layer.target_id, {
        error: normalized,
        field: null,
        identity: null,
        layer,
        reason: failureReason(normalized),
        status: "error",
      });
    }
  }

  private async resolveMetadata(
    layer: ModeCompositionLayer,
    loaders: ModeCompositionFieldLayerLoaders,
    signal: AbortSignal,
  ): Promise<ResolvedMetadata> {
    const key = metadataKey(layer);
    const cached = this.metadataCache.get(key);
    if (cached) return cached;
    const inflight = this.metadataInflight.get(key);
    if (inflight) return inflight;
    const pending = loaders.loadMetadata(layer, signal).then((metadata) => {
      if (signal.aborted) throw new Error("Mode field metadata request was aborted.");
      const resolved = validateMetadata(layer, metadata);
      this.metadataCache.set(key, resolved);
      return resolved;
    });
    this.metadataInflight.set(key, pending);
    return pending.finally(() => {
      if (this.metadataInflight.get(key) === pending) {
        this.metadataInflight.delete(key);
      }
    });
  }

  private async loadAndValidateBinary(
    layer: ModeCompositionLayer,
    topology: ModeCompositionFieldLayerTopologyIdentity,
    expectedIdentity: ModeFieldComplexBinaryIdentity | null,
    revisionKey: string,
    loaders: ModeCompositionFieldLayerLoaders,
    signal: AbortSignal,
  ) {
    const result = await loaders.loadBinary(layer, signal, null);
    const fieldRevision = validateBinary(layer, expectedIdentity, topology, result);
    const identity = expectedIdentity ?? createFieldIdentity(layer, topology, fieldRevision);
    this.fieldRevisions.set(revisionKey, fieldRevision);
    const key = modeFieldComplexBinaryResourceKey(identity);
    const entry = {
      byteLength: result.byteLength,
      data: { field: asDecodedComplexFieldVector(result.data)!, identity },
      etag: result.etag,
    };
    this.fieldCache.set(key, entry);
    return entry;
  }

  private isCurrent(requestToken: number): boolean {
    return this.requestToken === requestToken;
  }

  private replace(targetId: string, snapshot: ModeCompositionFieldLayerSnapshot): void {
    if (!this.snapshot.has(targetId)) return;
    const next = new Map(this.snapshot);
    next.set(targetId, snapshot);
    this.publish(next);
  }

  private publish(next: Map<string, ModeCompositionFieldLayerSnapshot>): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function groupLayersByTarget(
  layers: readonly ModeCompositionLayer[],
): ReadonlyMap<string, readonly ModeCompositionLayer[]> {
  const grouped = new Map<string, ModeCompositionLayer[]>();
  for (const layer of layers) {
    const current = grouped.get(layer.target_id);
    if (current) current.push(layer);
    else grouped.set(layer.target_id, [layer]);
  }
  return grouped;
}

function absentSnapshot(layer: ModeCompositionLayer): ModeCompositionFieldLayerSnapshot {
  return { error: null, field: null, identity: null, layer, reason: null, status: "absent" };
}

function preparingSnapshot(layer: ModeCompositionLayer): ModeCompositionFieldLayerSnapshot {
  return { error: null, field: null, identity: null, layer, reason: null, status: "preparing" };
}

function refreshingSnapshot(
  layer: ModeCompositionLayer,
  retained: RetainedField,
): ModeCompositionFieldLayerSnapshot {
  return {
    error: null,
    field: retained.field,
    identity: retained.identity,
    layer,
    reason: null,
    status: "refreshing",
  };
}

function errorSnapshot(
  layer: ModeCompositionLayer | null,
  message: string,
  reason: ModeCompositionFieldLayerFailureReason,
): ModeCompositionFieldLayerSnapshot {
  return {
    error: new Error(message),
    field: null,
    identity: null,
    layer,
    reason,
    status: "error",
  };
}

function validateLayer(
  resource: ModeCompositionResource,
  layer: ModeCompositionLayer,
  topology: ModeCompositionFieldLayerTopologyIdentity | null,
): string | null {
  if (layer.target_id !== `object:${layer.object_id}`) {
    return "Mode layer target/object identity is inconsistent.";
  }
  if (
    layer.mode.run_id !== resource.run_id ||
    layer.mode.stage_id !== resource.stage_id ||
    layer.mode.artifact_revision !== resource.artifact_revision ||
    !requiredString(layer.field_id) ||
    !requiredString(layer.mode.sample_id) ||
    !requiredString(layer.mode.mode_id) ||
    !isNonNegativeInteger(layer.mode.sample_index) ||
    !isNonNegativeInteger(layer.mode.raw_mode_index)
  ) {
    return "Mode layer identity is incomplete or does not match the active composition.";
  }
  if (!topology || !completeTopology(topology)) {
    return "Current target topology identity is incomplete.";
  }
  return null;
}

function validateMetadata(
  layer: ModeCompositionLayer,
  metadata: FrequencyDomainFieldResource,
): ResolvedMetadata {
  const metadataRevision = requiredString(metadata.revision) ?? requiredString(metadata.content_digest);
  if (
    metadata.status !== "ready" ||
    metadata.schema_version !== "frequency_domain_mode_field.v1" ||
    metadata.source_family !== "analysis/eigen" ||
    metadata.field_id !== layer.field_id ||
    metadata.quantity !== "delta_m" ||
    metadata.value_kind !== "complex_spatial_vector" ||
    metadata.component_basis !== "global_xyz" ||
    metadata.component_count !== 3 ||
    !arraysEqual(metadata.components, ["x", "y", "z"]) ||
    metadata.payload_encoding !== "f64_interleaved_real_imag_xyz" ||
    metadata.binary_layout !== "complex_f64_pairs_little_endian" ||
    !metadataRevision
  ) {
    throw new ModeCompositionFieldIdentityError(
      "Mode field metadata is incomplete or incompatible with a global complex XYZ field.",
    );
  }
  return { metadataRevision };
}

function createFieldIdentity(
  layer: ModeCompositionLayer,
  topology: ModeCompositionFieldLayerTopologyIdentity,
  fieldRevision: string,
): ModeFieldComplexBinaryIdentity {
  return {
    artifactRevision: layer.mode.artifact_revision,
    binaryEncoding: "FMVP;version=3",
    fieldId: layer.field_id,
    fieldRevision,
    generationId: topology.domainGenerationId!,
    modeId: layer.mode.mode_id,
    runId: layer.mode.run_id,
    sampleId: layer.mode.sample_id,
    scopeId: layer.object_id,
    scopeKind: "object",
    stageId: layer.mode.stage_id,
    topologyHash: topology.meshTopologyHash!,
  };
}

function validateBinary(
  layer: ModeCompositionLayer,
  expectedIdentity: ModeFieldComplexBinaryIdentity | null,
  topology: ModeCompositionFieldLayerTopologyIdentity,
  result: ModeCompositionFieldBinaryLoadResult,
): string {
  const field = result.data;
  const complex = asDecodedComplexFieldVector(field);
  const nodeIndices = field.nodeIndices;
  const fieldRevision = requiredString(result.fieldRevision);
  if (
    field.domainGenerationId !== topology.domainGenerationId ||
    field.meshTopologyHash !== topology.meshTopologyHash ||
    field.meshTopologyRevision !== topology.meshTopologyRevision
  ) {
    throw new ModeCompositionFieldTopologyError(
      "Object-scoped complex mode field does not match the current topology identity.",
    );
  }
  if (
    result.encoding !== "FMVP;version=3" ||
    !fieldRevision ||
    (expectedIdentity !== null && result.fieldRevision !== expectedIdentity.fieldRevision) ||
    !complex ||
    field.formatVersion !== 3 ||
    field.nComp !== 6 ||
    complex.componentCount !== 3 ||
    field.quantityId !== layer.field_id ||
    field.domainGenerationId !== topology.domainGenerationId ||
    field.meshTopologyHash !== topology.meshTopologyHash ||
    field.indexing !== "explicit_node_indices" ||
    field.scopeKind !== "object" ||
    field.scopeId !== layer.object_id ||
    field.pointCount <= 0 ||
    !nodeIndices ||
    nodeIndices.length !== field.pointCount ||
    field.valueCount !== field.pointCount * 6 ||
    field.values.length !== field.valueCount ||
    !allFinite(field.values)
  ) {
    throw new ModeCompositionFieldIdentityError(
      "Object-scoped complex mode field failed identity, topology, scope, or coverage validation.",
    );
  }
  return fieldRevision;
}

function metadataKey(layer: ModeCompositionLayer): string {
  return [
    layer.mode.run_id,
    layer.mode.stage_id,
    layer.mode.artifact_revision,
    layer.mode.sample_id,
    layer.mode.mode_id,
    layer.field_id,
  ].map(encodeURIComponent).join(":");
}

function fieldRevisionKey(
  layer: ModeCompositionLayer,
  topology: ModeCompositionFieldLayerTopologyIdentity,
  metadata: ResolvedMetadata,
): string {
  return [
    metadataKey(layer),
    metadata.metadataRevision,
    topology.domainGenerationId,
    topology.meshTopologyHash,
    topology.meshTopologyRevision,
  ].map((value) => encodeURIComponent(value ?? "")).join(":");
}

function completeTopology(
  topology: ModeCompositionFieldLayerTopologyIdentity,
): boolean {
  return Boolean(
    requiredString(topology.domainGenerationId) &&
    requiredString(topology.meshTopologyHash) &&
    requiredString(topology.meshTopologyRevision),
  );
}

function sameTopology(
  left: ModeCompositionFieldLayerTopologyIdentity,
  right: ModeCompositionFieldLayerTopologyIdentity,
): boolean {
  return left.domainGenerationId === right.domainGenerationId &&
    left.meshTopologyHash === right.meshTopologyHash &&
    left.meshTopologyRevision === right.meshTopologyRevision;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function arraysEqual(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

function allFinite(values: Float64Array): boolean {
  for (const value of values) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Mode composition field request failed.");
}

function isIdentityError(error: Error): boolean {
  return error instanceof ModeCompositionFieldIdentityError;
}

function failureReason(error: Error): ModeCompositionFieldLayerFailureReason {
  if (error instanceof ModeCompositionFieldTopologyError) {
    return "topology_mismatch";
  }
  if (error instanceof ModeCompositionFieldIdentityError) {
    return "identity_mismatch";
  }
  return "transport_error";
}

class ModeCompositionFieldIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeCompositionFieldIdentityError";
  }
}

class ModeCompositionFieldTopologyError extends ModeCompositionFieldIdentityError {
  constructor(message: string) {
    super(message);
    this.name = "ModeCompositionFieldTopologyError";
  }
}

async function runBounded<T>(
  values: readonly T[],
  requestedConcurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  const concurrency = Math.max(1, Math.min(requestedConcurrency, values.length));
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      await run(values[index]!);
    }
  }));
}
