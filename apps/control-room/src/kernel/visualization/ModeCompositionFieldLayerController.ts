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
  readonly artifactGenerationId: string | null;
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
    expectedArtifactGenerationId: string,
    etag?: string | null,
  ): Promise<ModeCompositionFieldBinaryLoadResult>;
  loadMetadata(
    layer: ModeCompositionLayer,
    signal: AbortSignal,
  ): Promise<FrequencyDomainFieldResource>;
}

interface ResolvedMetadata {
  readonly artifactGenerationId: string;
  readonly metadataRevision: string;
}

type ModeCompositionFieldBinaryEncoding = "FMVP;version=3" | "FMVP;version=5";

interface ResolvedFieldRevision {
  readonly binaryEncoding: ModeCompositionFieldBinaryEncoding;
  readonly fieldRevision: string;
}

interface CachedField {
  readonly field: DecodedComplexFieldVector;
  readonly identity: ModeFieldComplexBinaryIdentity;
}

interface RetainedField extends CachedField {
  readonly layer: ModeCompositionLayer;
  readonly metadataRevision: string;
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
  private readonly fieldRevisions = new Map<string, ResolvedFieldRevision>();
  private readonly metadataCache = new Map<string, ResolvedMetadata>();
  private readonly metadataInflight = new Map<string, Promise<ResolvedMetadata>>();
  private requestToken = 0;
  private readonly retained = new Map<string, RetainedField>();
  private activeSessionScope: string | null = null;
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
    this.metadataCache.clear();
    this.metadataInflight.clear();
    this.retained.clear();
    this.publish(new Map());
  }

  async activate(
    resource: ModeCompositionResource | null | undefined,
    topologyByTarget: Readonly<Record<string, ModeCompositionFieldLayerTopologyIdentity | null | undefined>>,
    loaders: ModeCompositionFieldLayerLoaders,
    sessionScope: string | null = null,
  ): Promise<"cancelled" | "completed"> {
    if (this.activeSessionScope !== sessionScope) {
      this.abortController?.abort();
      this.fieldCache.clear();
      this.fieldRevisions.clear();
      this.metadataCache.clear();
      this.metadataInflight.clear();
      this.retained.clear();
      this.activeSessionScope = sessionScope;
    }
    const requestToken = ++this.requestToken;
    this.abortController?.abort();
    // Artifact generation is part of metadata identity and is only known after
    // this activation's read. Keep request deduplication within this activation,
    // but never carry a prior activation's metadata answer forward.
    this.metadataCache.clear();
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
        // The previous payload is hidden until fresh metadata proves that its
        // exact committed generation still owns this layer.
        next.set(targetId, preparingSnapshot(layer));
        active.push({ layer, topology: topology! });
      }
    }

    this.publish(next);
    const resolvedMetadata = new Map<string, ResolvedMetadata>();
    const metadataErrors = new Map<string, Error>();
    await runBounded(active, this.maxConcurrentLoads, async ({ layer }) => {
      try {
        resolvedMetadata.set(
          layer.target_id,
          await this.resolveMetadata(layer, loaders, abortController.signal),
        );
      } catch (error) {
        metadataErrors.set(layer.target_id, normalizeError(error));
      }
    });

    if (this.requestToken !== requestToken) return "cancelled";
    const artifactGenerations = new Set(
      [...resolvedMetadata.values()].map((metadata) => metadata.artifactGenerationId),
    );
    if (metadataErrors.size > 0 || artifactGenerations.size > 1) {
      const rejected = new Map(this.snapshot);
      for (const { layer } of active) {
        this.retained.delete(layer.target_id);
        const metadataError = metadataErrors.get(layer.target_id);
        const reason = metadataError
          ? failureReason(metadataError)
          : "identity_mismatch";
        rejected.set(
          layer.target_id,
          errorSnapshot(
            layer,
            metadataError?.message ?? (artifactGenerations.size > 1
              ? "Mode composition includes fields from different committed artifact generations."
              : [...metadataErrors.values()].some(isIdentityError)
                ? "Mode composition cannot join fields when any member lacks an owner-bound committed artifact generation."
                : "Mode composition cannot verify every member's committed artifact generation."),
            reason,
          ),
        );
      }
      this.publish(rejected);
    } else {
      const refreshed = new Map(this.snapshot);
      for (const { layer, topology } of active) {
        const metadata = resolvedMetadata.get(layer.target_id);
        const retained = this.retained.get(layer.target_id);
        const expectedFieldIdentity = metadata
          ? this.fieldRevisions.get(fieldRevisionKey(layer, topology, metadata)) ?? null
          : null;
        if (
          !metadata ||
          !retained ||
          !sameRetainedIdentity(
            retained,
            layer,
            topology,
            metadata,
            expectedFieldIdentity,
          )
        ) {
          this.retained.delete(layer.target_id);
          refreshed.set(layer.target_id, preparingSnapshot(layer));
          continue;
        }
        refreshed.set(layer.target_id, refreshingSnapshot(layer, retained));
      }
      // Remove every stale-generation fallback before any target can publish a
      // newly loaded field, so intermediate snapshots cannot mix publications.
      this.publish(refreshed);
      await runBounded(active, this.maxConcurrentLoads, async ({ layer, topology }) => {
        await this.loadLayer(
          requestToken,
          layer,
          topology,
          loaders,
          abortController.signal,
          resolvedMetadata.get(layer.target_id) ?? null,
          metadataErrors.get(layer.target_id) ?? null,
        );
      });
    }

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
    preloadedMetadata: ResolvedMetadata | null,
    metadataError: Error | null,
  ): Promise<void> {
    try {
      if (metadataError) throw metadataError;
      const metadata = preloadedMetadata ?? await this.resolveMetadata(layer, loaders, signal);
      if (!this.isCurrent(requestToken)) return;
      const revisionKey = fieldRevisionKey(layer, topology, metadata);
      const resolvedFieldRevision = this.fieldRevisions.get(revisionKey) ?? null;
      const identity = resolvedFieldRevision
        ? createFieldIdentity(
            layer,
            topology,
            resolvedFieldRevision.fieldRevision,
            metadata.artifactGenerationId,
            resolvedFieldRevision.binaryEncoding,
          )
        : null;
      const cached = identity
        ? this.fieldCache.get(modeFieldComplexBinaryResourceKey(identity))
        : null;
      const entry = cached ?? await this.loadAndValidateBinary(
        layer,
        topology,
        metadata,
        identity,
        revisionKey,
        loaders,
        signal,
      );
      if (!this.isCurrent(requestToken)) return;
      const retained: RetainedField = {
        ...entry.data,
        layer,
        metadataRevision: metadata.metadataRevision,
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
    metadata: ResolvedMetadata,
    expectedIdentity: ModeFieldComplexBinaryIdentity | null,
    revisionKey: string,
    loaders: ModeCompositionFieldLayerLoaders,
    signal: AbortSignal,
  ) {
    const result = await loaders.loadBinary(
      layer,
      signal,
      metadata.artifactGenerationId,
      null,
    );
    const resolvedFieldRevision = validateBinary(
      layer,
      expectedIdentity,
      topology,
      result,
      metadata.artifactGenerationId,
    );
    const identity = expectedIdentity ?? createFieldIdentity(
      layer,
      topology,
      resolvedFieldRevision.fieldRevision,
      metadata.artifactGenerationId,
      resolvedFieldRevision.binaryEncoding,
    );
    this.fieldRevisions.set(revisionKey, resolvedFieldRevision);
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
  const artifactGenerationId = requiredString(metadata.generation_id);
  if (metadata.generation_status === "member_verified_unbound") {
    throw new ModeCompositionFieldIdentityError(
      "Mode composition rejects member_verified_unbound field artifacts; an owner-bound committed generation is required.",
    );
  }
  if (
    metadata.generation_status !== "member_verified_owner_bound" ||
    !artifactGenerationId
  ) {
    throw new ModeCompositionFieldIdentityError(
      "Mode composition requires a nonempty member_verified_owner_bound artifact generation; legacy fields cannot join a composition.",
    );
  }
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
  return { artifactGenerationId, metadataRevision };
}

function createFieldIdentity(
  layer: ModeCompositionLayer,
  topology: ModeCompositionFieldLayerTopologyIdentity,
  fieldRevision: string,
  artifactGenerationId: string,
  binaryEncoding: ModeCompositionFieldBinaryEncoding,
): ModeFieldComplexBinaryIdentity {
  return {
    artifactGenerationId,
    artifactRevision: layer.mode.artifact_revision,
    binaryEncoding,
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
  expectedArtifactGenerationId: string,
): ResolvedFieldRevision {
  const field = result.data;
  const complex = asDecodedComplexFieldVector(field);
  const nodeIndices = field.nodeIndices;
  const fieldRevision = requiredString(result.fieldRevision);
  if (result.artifactGenerationId !== expectedArtifactGenerationId) {
    throw new ModeCompositionFieldIdentityError(
      "Mode field artifact generation header is missing or does not match the owner-bound metadata member.",
    );
  }
  if (
    field.domainGenerationId !== topology.domainGenerationId ||
    field.meshTopologyHash !== topology.meshTopologyHash ||
    field.meshTopologyRevision !== topology.meshTopologyRevision
  ) {
    throw new ModeCompositionFieldTopologyError(
      "Object-scoped complex mode field does not match the current topology identity.",
    );
  }
  const binaryEncoding = supportedModeCompositionFieldEncoding(
    result.encoding,
    field.formatVersion,
  );
  if (!binaryEncoding) {
    throw new ModeCompositionFieldIdentityError(
      "Object-scoped complex mode field requires a matching FMVP v3 or v5 header and decoded format version.",
    );
  }
  if (
    !fieldRevision ||
    (expectedIdentity !== null && (
      result.fieldRevision !== expectedIdentity.fieldRevision ||
      binaryEncoding !== expectedIdentity.binaryEncoding
    )) ||
    !complex ||
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
  return { binaryEncoding, fieldRevision };
}

function supportedModeCompositionFieldEncoding(
  encoding: string | null,
  formatVersion: number | undefined,
): ModeCompositionFieldBinaryEncoding | null {
  if (encoding === "FMVP;version=3" && formatVersion === 3) return encoding;
  if (encoding === "FMVP;version=5" && formatVersion === 5) return encoding;
  return null;
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
    metadata.artifactGenerationId,
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

function sameRetainedIdentity(
  retained: RetainedField,
  layer: ModeCompositionLayer,
  topology: ModeCompositionFieldLayerTopologyIdentity,
  metadata: ResolvedMetadata,
  expectedFieldIdentity: ResolvedFieldRevision | null,
): boolean {
  const identity = retained.identity;
  return Boolean(
    expectedFieldIdentity &&
    identity.fieldRevision === expectedFieldIdentity.fieldRevision &&
    identity.binaryEncoding === expectedFieldIdentity.binaryEncoding &&
    identity.artifactGenerationId === metadata.artifactGenerationId &&
    retained.metadataRevision === metadata.metadataRevision &&
    identity.runId === layer.mode.run_id &&
    identity.stageId === layer.mode.stage_id &&
    identity.artifactRevision === layer.mode.artifact_revision &&
    identity.sampleId === layer.mode.sample_id &&
    identity.modeId === layer.mode.mode_id &&
    identity.fieldId === layer.field_id &&
    identity.scopeKind === "object" &&
    identity.scopeId === layer.object_id &&
    identity.generationId === topology.domainGenerationId &&
    identity.topologyHash === topology.meshTopologyHash &&
    sameTopology(retained.topology, topology)
  );
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
  return error instanceof ModeCompositionFieldIdentityError || isHttpConflict(error);
}

function failureReason(error: Error): ModeCompositionFieldLayerFailureReason {
  if (isHttpConflict(error)) {
    return "identity_mismatch";
  }
  if (error instanceof ModeCompositionFieldTopologyError) {
    return "topology_mismatch";
  }
  if (error instanceof ModeCompositionFieldIdentityError) {
    return "identity_mismatch";
  }
  return "transport_error";
}

function isHttpConflict(error: Error): boolean {
  return (error as Error & { readonly status?: unknown }).status === 409;
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
