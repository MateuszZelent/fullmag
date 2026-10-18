import type { ComputeNodePolicyUpdateRequest } from "@/kernel/api/apiTypes";

import type { ComputeNodePolicySummary } from "./types";

const BYTE_GIB = 1024 ** 3;
const MAX_CPU_IDS = 4096;
const MAX_POLICY_WORKERS = 4096;

export interface ComputeNodePolicyFormDraft {
  readonly allowedCpuIds: string;
  readonly allowedGpuUuids: readonly string[];
  readonly cpuReserve: string;
  readonly memoryReserveGiB: string;
  readonly scratchReserveGiB: string;
  readonly gpuVramReserveGiB: Readonly<Record<string, string>>;
  readonly maxParallelWorkers: string;
  readonly draining: boolean;
  /** Fields without editors are preserved from the server document. */
  readonly priorityOrder: readonly number[];
  readonly allowedParallelismPatterns: ComputeNodePolicySummary["allowedParallelismPatterns"];
}

export type ComputeNodePolicyDraftResult =
  | {
      readonly ok: true;
      readonly policy: ComputeNodePolicyUpdateRequest["policy"];
    }
  | { readonly ok: false; readonly error: string };

export function createComputeNodePolicyDraft(
  policy: ComputeNodePolicySummary,
): ComputeNodePolicyFormDraft {
  const gpuReserves: Record<string, string> = {};
  for (const [uuid, bytes] of Object.entries(policy.gpuVramReserves)) {
    gpuReserves[uuid] = bytesToGiBInput(bytes);
  }
  return {
    allowedCpuIds: formatCpuIds(policy.allowedCpuIds),
    allowedGpuUuids: [...policy.allowedGpuUuids],
    cpuReserve: (policy.cpuReserveMillis / 1000).toString(),
    memoryReserveGiB: bytesToGiBInput(policy.memoryReserveBytes),
    scratchReserveGiB: bytesToGiBInput(policy.scratchReserveBytes),
    gpuVramReserveGiB: gpuReserves,
    maxParallelWorkers: policy.maxParallelWorkers.toString(),
    draining: policy.draining,
    priorityOrder: [...policy.priorityOrder],
    allowedParallelismPatterns: policy.allowedParallelismPatterns,
  };
}

export function buildComputeNodePolicyUpdate(
  draft: ComputeNodePolicyFormDraft,
): ComputeNodePolicyDraftResult {
  const allowedCpuIds = parseCpuIds(draft.allowedCpuIds);
  if (!allowedCpuIds.ok) return allowedCpuIds;
  const cpuReserve = parseNonNegativeNumber(draft.cpuReserve, "CPU reserve");
  if (!cpuReserve.ok) return cpuReserve;
  const cpuMillis = Math.round(cpuReserve.value * 1000);
  if (!Number.isSafeInteger(cpuMillis) || Math.abs(cpuReserve.value * 1000 - cpuMillis) > 1e-8) {
    return { ok: false, error: "CPU reserve must use increments of 0.001 CPU equivalents." };
  }
  const memoryBytes = parseGiB(draft.memoryReserveGiB, "RAM reserve");
  if (!memoryBytes.ok) return memoryBytes;
  const scratchBytes = parseGiB(draft.scratchReserveGiB, "Scratch reserve");
  if (!scratchBytes.ok) return scratchBytes;
  const maxParallelWorkers = Number(draft.maxParallelWorkers);
  if (
    !Number.isSafeInteger(maxParallelWorkers) ||
    maxParallelWorkers < 1 ||
    maxParallelWorkers > MAX_POLICY_WORKERS
  ) {
    return {
      ok: false,
      error: `Maximum active workers must be a whole number from 1 to ${MAX_POLICY_WORKERS}.`,
    };
  }

  const gpuVramReserves: Record<string, number> = {};
  for (const [uuid, value] of Object.entries(draft.gpuVramReserveGiB)) {
    const parsed = parseGiB(value, `VRAM reserve for ${uuid}`);
    if (!parsed.ok) return parsed;
    if (parsed.value > 0) gpuVramReserves[uuid] = parsed.value;
  }

  return {
    ok: true,
    policy: {
      allowed_cpu_ids: [...allowedCpuIds.value],
      allowed_gpu_uuids: [...new Set(draft.allowedGpuUuids)].sort(),
      reserved_budget: {
        cpu_millis: cpuMillis,
        memory_bytes: memoryBytes.value,
        gpu_memory_bytes: 0,
        storage_bytes: scratchBytes.value,
      },
      reserved_gpu_vram_bytes_by_uuid: gpuVramReserves,
      max_parallel_workers: maxParallelWorkers,
      priority_order: [...draft.priorityOrder],
      draining: draft.draining,
      allowed_parallelism_patterns: draft.allowedParallelismPatterns.map((pattern) =>
        pattern.kind === "single_process"
          ? { kind: "single_process" as const }
          : {
              kind: "distributed" as const,
              ranks: pattern.ranks,
              threads_per_rank: pattern.threads_per_rank,
              ranks_per_node: pattern.ranks_per_node,
              gpus_per_rank: pattern.gpus_per_rank,
            }),
    },
  };
}

export function formatCpuIds(ids: readonly number[]): string {
  const sorted = [...new Set(ids)].sort((left, right) => left - right);
  const parts: string[] = [];
  for (let index = 0; index < sorted.length;) {
    const start = sorted[index];
    let end = start;
    while (index + 1 < sorted.length && sorted[index + 1] === end + 1) {
      index += 1;
      end = sorted[index];
    }
    parts.push(start === end ? `${start}` : `${start}-${end}`);
    index += 1;
  }
  return parts.join(", ");
}

function parseCpuIds(input: string): { readonly ok: true; readonly value: readonly number[] } | { readonly ok: false; readonly error: string } {
  const source = input.trim();
  if (!source) return { ok: true, value: [] };
  const ids = new Set<number>();
  for (const part of source.split(",")) {
    const token = part.trim();
    const rangeMatch = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (!rangeMatch) {
      return { ok: false, error: "Enter CPU IDs as numbers or ranges, for example 0-7, 12." };
    }
    const start = Number(rangeMatch[1]);
    const end = rangeMatch[2] === undefined ? start : Number(rangeMatch[2]);
    if (
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || end > 0xffff_ffff
    ) {
      return { ok: false, error: "CPU ID ranges must be ascending non-negative 32-bit values." };
    }
    if (end - start + 1 + ids.size > MAX_CPU_IDS) {
      return { ok: false, error: `A policy can include at most ${MAX_CPU_IDS} CPU IDs.` };
    }
    for (let id = start; id <= end; id += 1) {
      if (ids.has(id)) return { ok: false, error: "CPU IDs and ranges cannot contain duplicates." };
      ids.add(id);
    }
  }
  return { ok: true, value: [...ids].sort((left, right) => left - right) };
}

function parseNonNegativeNumber(
  input: string,
  label: string,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string } {
  if (!input.trim()) return { ok: false, error: `${label} is required.` };
  const value = Number(input);
  return Number.isFinite(value) && value >= 0
    ? { ok: true, value }
    : { ok: false, error: `${label} must be a non-negative number.` };
}

function parseGiB(
  input: string,
  label: string,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string } {
  const parsed = parseNonNegativeNumber(input, label);
  if (!parsed.ok) return parsed;
  const bytes = Math.round(parsed.value * BYTE_GIB);
  return Number.isSafeInteger(bytes)
    ? { ok: true, value: bytes }
    : { ok: false, error: `${label} is outside the range that can be represented safely.` };
}

function bytesToGiBInput(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "0";
  return (bytes / BYTE_GIB).toString();
}
