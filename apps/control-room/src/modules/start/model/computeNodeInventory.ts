import type { ComputeNodesResource } from "@/kernel/api/apiTypes";
import type { ResourceResult } from "@/kernel/resources/resourceTypes";

import type {
  ComputeNodeCpuTopologySummary,
  ComputeNodeEnforcementStatus,
  ComputeNodeFact,
  ComputeNodeGpuPartition,
  ComputeNodeGpuSummary,
  ComputeNodeInventorySummary,
  ComputeNodeParallelismPattern,
  ComputeNodePolicySummary,
  ComputeNodeSnapshotSummary,
} from "./types";

type RecordValue = Record<string, unknown>;
type ValueParser<T> = (value: unknown) => T | null;

function asRecord(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = nonNegativeInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function readReported<T>(input: unknown, parse: ValueParser<T>): ComputeNodeFact<T> {
  const report = asRecord(input);
  if (report?.status === "available") {
    const value = parse(report.value);
    return value === null
      ? { status: "unavailable", value: null }
      : { status: "available", value };
  }
  if (report?.status === "unavailable" && Object.hasOwn(report, "last_known")) {
    const value = parse(report.last_known);
    if (value !== null) return { status: "last_known", value };
  }
  return { status: "unavailable", value: null };
}

function readObservation(input: unknown): { readonly available: boolean; readonly value: number | null } {
  const observation = asRecord(input);
  if (observation?.status !== "available") return { available: false, value: null };
  const value = nonNegativeInteger(observation.value);
  return { available: value !== null, value };
}

function optionalNonNegativeInteger(record: RecordValue, key: string): number | null | undefined {
  const value = record[key];
  if (value === null || value === undefined) return null;
  return nonNegativeInteger(value) ?? undefined;
}

function parseCpuTopology(value: unknown): ComputeNodeCpuTopologySummary | null {
  const topology = asRecord(value);
  if (!Array.isArray(topology?.logical_cpus)) return null;
  const processors = topology.logical_cpus.map((processor) => {
    const record = asRecord(processor);
    if (!record) return null;
    const id = nonNegativeInteger(record.id);
    const socketId = optionalNonNegativeInteger(record, "socket_id");
    const numaNodeId = optionalNonNegativeInteger(record, "numa_node_id");
    const coreId = optionalNonNegativeInteger(record, "core_id");
    return id === null || socketId === undefined || numaNodeId === undefined || coreId === undefined
      ? null
      : { id, socketId, numaNodeId, coreId };
  });
  const validProcessors = processors.filter(
    (processor): processor is Exclude<typeof processor, null> => processor !== null,
  );
  if (processors.length === 0 || validProcessors.length !== processors.length) {
    return null;
  }
  for (let index = 1; index < validProcessors.length; index += 1) {
    const previous = validProcessors[index - 1];
    const current = validProcessors[index];
    if (previous && current && previous.id >= current.id) return null;
  }
  const socketIds = [...new Set(validProcessors.flatMap((processor) =>
    processor.socketId === null ? [] : [processor.socketId]))].sort((left, right) => left - right);
  const numaNodeIds = [...new Set(validProcessors.flatMap((processor) =>
    processor.numaNodeId === null ? [] : [processor.numaNodeId]))].sort((left, right) => left - right);
  const hasCompleteCoreTopology = validProcessors.every((processor) =>
    processor.socketId !== null && processor.coreId !== null);
  const physicalCores = hasCompleteCoreTopology
    ? new Set(validProcessors.map((processor) => `${processor.socketId}:${processor.coreId}`))
    : null;
  return {
    logicalProcessorCount: validProcessors.length,
    logicalCpuIds: validProcessors.map((processor) => processor.id),
    socketIds,
    numaNodeIds,
    physicalCoreCount: physicalCores?.size ?? null,
  };
}

function parseCpuSet(value: unknown): readonly number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids = value.map(nonNegativeInteger);
  const validIds = ids.filter((id): id is number => id !== null);
  if (validIds.length !== ids.length) return null;
  for (let index = 1; index < validIds.length; index += 1) {
    const previous = validIds[index - 1];
    const current = validIds[index];
    if (previous === undefined || current === undefined || previous >= current) return null;
  }
  return validIds;
}

function parseGpuPartition(value: unknown): ComputeNodeGpuPartition | null {
  const partition = asRecord(value);
  if (!partition) return null;
  if (partition.kind === "full_device") return { kind: "full_device" };
  if (partition.kind === "unknown") return { kind: "unknown" };
  if (partition.kind === "mig") {
    const parentGpuUuid = nonEmptyString(partition.parent_gpu_uuid);
    const partitionId = nonEmptyString(partition.partition_id);
    return parentGpuUuid && partitionId
      ? { kind: "mig", parentGpuUuid, partitionId }
      : null;
  }
  return null;
}

function parseNumaNodeId(value: unknown): number | null {
  const topology = asRecord(value);
  return topology ? nonNegativeInteger(topology.numa_node_id) : null;
}

function parseGpu(value: unknown): ComputeNodeGpuSummary | null {
  const gpu = asRecord(value);
  const uuid = nonEmptyString(gpu?.uuid);
  if (!gpu || !uuid) return null;
  return {
    uuid,
    name: readReported(gpu.name, nonEmptyString),
    pciId: readReported(gpu.pci_id, nonEmptyString),
    vramBytes: readReported(gpu.vram_bytes, nonNegativeInteger),
    partition: readReported(gpu.partition, parseGpuPartition),
    numaNodeId: readReported(gpu.topology, parseNumaNodeId),
  };
}

function parseGpuList(value: unknown): readonly ComputeNodeGpuSummary[] | null {
  if (!Array.isArray(value)) return null;
  const devices = value.map(parseGpu);
  const validDevices = devices.filter((device): device is ComputeNodeGpuSummary => device !== null);
  const uniqueUuids = new Set(validDevices.map((device) => device.uuid));
  return validDevices.length === devices.length && uniqueUuids.size === validDevices.length
    ? validDevices
    : null;
}

function parseCpuQuota(value: unknown):
  | { readonly mode: "unlimited" }
  | { readonly mode: "limited"; readonly capacityMillis: number }
  | null {
  const quota = asRecord(value);
  if (quota?.mode === "unlimited") return { mode: "unlimited" };
  if (quota?.mode === "limited") {
    const capacityMillis = nonNegativeInteger(quota.capacity_millis);
    return capacityMillis !== null && capacityMillis > 0
      ? { mode: "limited", capacityMillis }
      : null;
  }
  return null;
}

function parseEnforcement(value: unknown): ComputeNodeEnforcementStatus | null {
  return value === "supported" || value === "advisory" || value === "unavailable"
    ? value
    : null;
}

function parseSampleTime(value: unknown): string | null {
  const sampleTime = nonEmptyString(value);
  return sampleTime !== null && Number.isFinite(Date.parse(sampleTime)) ? sampleTime : null;
}

function parseIntegerList(value: unknown, allowNegative = false): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map((item) =>
    typeof item === "number" && Number.isSafeInteger(item) && (allowNegative || item >= 0)
      ? item
      : null,
  );
  const parsed = values.filter((item): item is number => item !== null);
  if (parsed.length !== values.length) return null;
  return new Set(parsed).size === parsed.length ? parsed : null;
}

function parseUniqueStringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.map(nonEmptyString);
  const parsed = values.filter((item): item is string => item !== null);
  if (parsed.length !== values.length) return null;
  return new Set(parsed).size === parsed.length ? parsed : null;
}

function parseParallelismPatterns(value: unknown): readonly ComputeNodeParallelismPattern[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return null;
  const parsed: ComputeNodeParallelismPattern[] = [];
  for (const item of value) {
    const pattern = asRecord(item);
    if (pattern?.kind === "single_process") {
      parsed.push({ kind: "single_process" });
      continue;
    }
    if (pattern?.kind !== "distributed") return null;
    const ranks = positiveInteger(pattern.ranks);
    const threadsPerRank = positiveInteger(pattern.threads_per_rank);
    const ranksPerNode = positiveInteger(pattern.ranks_per_node);
    const gpusPerRank = nonNegativeInteger(pattern.gpus_per_rank);
    if (
      ranks === null || threadsPerRank === null || ranksPerNode === null ||
      gpusPerRank === null || ranksPerNode > ranks
    ) return null;
    parsed.push({
      kind: "distributed",
      ranks,
      threads_per_rank: threadsPerRank,
      ranks_per_node: ranksPerNode,
      gpus_per_rank: gpusPerRank,
    });
  }
  return new Set(parsed.map((item) => JSON.stringify(item))).size === parsed.length
    ? parsed
    : null;
}

export function parseComputeNodePolicyResource(input: unknown): ComputeNodePolicySummary | null {
  const resource = asRecord(input);
  const policy = asRecord(resource?.policy);
  const status = asRecord(resource?.status);
  const reservedBudget = asRecord(policy?.reserved_budget);
  const gpuReserves = asRecord(policy?.reserved_gpu_vram_bytes_by_uuid ?? {});
  const revision = nonNegativeInteger(policy?.revision);
  const statusRevision = nonNegativeInteger(status?.revision);
  const activeWorkers = nonNegativeInteger(status?.active_workers);
  const maxParallelWorkers = nonNegativeInteger(policy?.max_parallel_workers);
  const cpuReserveMillis = nonNegativeInteger(reservedBudget?.cpu_millis);
  const memoryReserveBytes = nonNegativeInteger(reservedBudget?.memory_bytes);
  const scratchReserveBytes = nonNegativeInteger(reservedBudget?.storage_bytes);
  const allowedCpuIds = parseIntegerList(policy?.allowed_cpu_ids);
  const allowedGpuUuids = parseUniqueStringList(policy?.allowed_gpu_uuids);
  const priorityOrder = parseIntegerList(policy?.priority_order, true);
  const patterns = parseParallelismPatterns(policy?.allowed_parallelism_patterns);
  const reasons = parseUniqueStringList(status?.blocking_reasons);

  if (
    !resource ||
    !policy ||
    !status ||
    policy.schema_version !== "compute_node_policy.v1" ||
    revision === null || revision < 1 || statusRevision !== revision ||
    activeWorkers === null || maxParallelWorkers === null || maxParallelWorkers < 1 ||
    cpuReserveMillis === null || memoryReserveBytes === null || scratchReserveBytes === null ||
    reservedBudget?.gpu_memory_bytes !== 0 ||
    allowedCpuIds === null || allowedGpuUuids === null || priorityOrder === null ||
    patterns === null ||
    reasons === null || typeof policy.draining !== "boolean" ||
    typeof status.draining !== "boolean" || policy.draining !== status.draining ||
    typeof status.over_budget !== "boolean"
  ) {
    return null;
  }

  const normalizedGpuReserves: Record<string, number> = {};
  for (const [uuid, bytes] of Object.entries(gpuReserves ?? {})) {
    const parsedBytes = nonNegativeInteger(bytes);
    if (parsedBytes === null) return null;
    normalizedGpuReserves[uuid] = parsedBytes;
  }

  return {
    revision,
    activeWorkers,
    maxParallelWorkers,
    draining: policy.draining,
    overBudget: status.over_budget,
    blockingReasons: reasons,
    allowedCpuIds,
    allowedGpuUuids,
    cpuReserveMillis,
    memoryReserveBytes,
    scratchReserveBytes,
    gpuVramReserves: normalizedGpuReserves,
    priorityOrder,
    parallelismPatternCount: patterns.length,
    allowedParallelismPatterns: patterns,
  };
}

export function parseComputeNodeSnapshot(
  expectedNodeId: string,
  input: unknown,
): ComputeNodeSnapshotSummary | null {
  const snapshot = asRecord(input);
  const nodeId = nonEmptyString(snapshot?.node_id);
  const inventoryRevision = nonNegativeInteger(snapshot?.inventory_revision);
  const cpu = asRecord(snapshot?.cpu);
  const osConstraints = asRecord(cpu?.os_constraints);
  const memory = asRecord(snapshot?.memory);
  const sample = asRecord(snapshot?.sample);
  const enforcement = asRecord(snapshot?.enforcement);
  const schemaVersion = nonEmptyString(snapshot?.schema_version);
  const hostOwnerId = nonEmptyString(snapshot?.host_owner_id);
  const hostOwnerEpoch = nonNegativeInteger(snapshot?.host_owner_epoch);
  const schemaSupported =
    (schemaVersion === "compute_node_snapshot.v1" &&
      snapshot?.host_owner_id === undefined &&
      snapshot?.host_owner_epoch === undefined) ||
    (schemaVersion === "compute_node_snapshot.v2" &&
      hostOwnerId !== null &&
      hostOwnerEpoch !== null &&
      hostOwnerEpoch > 0);

  if (
    !snapshot ||
    !schemaSupported ||
    nodeId === null ||
    nodeId !== expectedNodeId ||
    inventoryRevision === null ||
    inventoryRevision < 1 ||
    !cpu ||
    !osConstraints ||
    !memory ||
    !sample ||
    !enforcement
  ) {
    return null;
  }

  const effectiveCapacity = readObservation(cpu.effective_capacity_millis);
  const totalBytes = readObservation(memory.total_bytes);
  const availableBytes = readObservation(memory.available_bytes);
  const freshness = asRecord(sample.freshness);
  const source = nonEmptyString(sample.source);
  const collectedAt = parseSampleTime(sample.collected_at);
  const effectiveCapacityMillis = effectiveCapacity.value;
  const allowedLogicalProcessors = readReported(
    osConstraints.allowed_logical_cpu_ids,
    parseCpuSet,
  );

  return {
    nodeId,
    inventoryRevision,
    sample: {
      source,
      collectedAt,
      freshness: nonEmptyString(freshness?.status),
    },
    cpu: {
      topology: readReported(
        cpu.topology,
        parseCpuTopology,
      ),
      allowedLogicalProcessorIds: allowedLogicalProcessors,
      effectiveCapacityMillis,
      effectiveCapacityAvailable: effectiveCapacity.available,
      quota: readReported(osConstraints.quota, parseCpuQuota),
    },
    memory: {
      totalBytes: totalBytes.value,
      availableBytes: availableBytes.value,
    },
    gpus: readReported(snapshot.gpus, parseGpuList),
    enforcement: {
      cpuAffinity: parseEnforcement(enforcement.cpu_affinity),
      cpuQuota: parseEnforcement(enforcement.cpu_quota),
      memoryCap: parseEnforcement(enforcement.memory_cap),
      gpuVisibility: parseEnforcement(enforcement.gpu_visibility),
      storageQuota: parseEnforcement(enforcement.storage_quota),
    },
  };
}

export function summarizeComputeNodeInventory(
  resource: Pick<ResourceResult<ComputeNodesResource>, "data" | "refreshError" | "status">,
  nowUnixMs = Date.now(),
): ComputeNodeInventorySummary {
  const staleAfterSeconds = resource.data?.stale_after_seconds;
  const usableStaleAfterSeconds = typeof staleAfterSeconds === "number" &&
    Number.isSafeInteger(staleAfterSeconds) && staleAfterSeconds > 0
    ? staleAfterSeconds
    : null;
  const nodes = resource.data?.nodes.map((node) => {
    const parsedSnapshot = parseComputeNodeSnapshot(node.node_id, node.snapshot);
    let sampleFreshness = parsedSnapshot
      ? currentSampleFreshness(parsedSnapshot.sample, usableStaleAfterSeconds, nowUnixMs)
      : null;
    let state = parsedSnapshot ? node.state : "unavailable";
    if (
      state !== "unavailable" &&
      (sampleFreshness === null || sampleFreshness === "unavailable")
    ) {
      state = "unavailable";
    }
    if (state === "current" && sampleFreshness === "stale") state = "stale";
    if (state === "stale" && sampleFreshness === "current") sampleFreshness = "stale";

    return {
      nodeId: node.node_id,
      state,
      nodePolicy: parseComputeNodePolicyResource(node.node_policy),
      snapshot: parsedSnapshot && sampleFreshness !== parsedSnapshot.sample.freshness
        ? { ...parsedSnapshot, sample: { ...parsedSnapshot.sample, freshness: sampleFreshness } }
        : parsedSnapshot,
    };
  }) ?? [];

  return {
    hasSnapshot: resource.data !== null,
    nodeCount: resource.data?.nodes.length ?? 0,
    nodes,
    refreshFailed: Boolean(resource.refreshError) ||
      (resource.status === "error" && resource.data !== null),
    resourceStatus: resource.status,
    staleAfterSeconds: usableStaleAfterSeconds,
    state: aggregateNodeState(nodes.map((node) => node.state), resource.data?.state ?? null),
  };
}

function currentSampleFreshness(
  sample: ComputeNodeSnapshotSummary["sample"],
  staleAfterSeconds: number | null,
  nowUnixMs: number,
): string | null {
  if (sample.freshness !== "current" || staleAfterSeconds === null || sample.collectedAt === null) {
    return sample.freshness;
  }
  const collectedAt = Date.parse(sample.collectedAt);
  if (!Number.isFinite(collectedAt) || nowUnixMs < collectedAt) return "unavailable";
  return nowUnixMs - collectedAt > staleAfterSeconds * 1000 ? "stale" : "current";
}

function aggregateNodeState(
  states: readonly ComputeNodesResource["nodes"][number]["state"][],
  fallback: ComputeNodesResource["state"] | null,
): ComputeNodesResource["state"] | null {
  if (states.includes("unavailable")) return "unavailable";
  if (states.includes("stale")) return "stale";
  if (states.includes("current")) return "current";
  return fallback;
}
