type RecordValue = Record<string, unknown>;

const originKinds = new Set([
  "product_default",
  "profile",
  "script",
  "study",
  "step",
  "submit",
  "cli",
  "legacy_env",
]);

interface ProjectRunTaskExecutionOrigin {
  readonly field: string;
  readonly kind: string;
  readonly location: string;
}

export interface ProjectRunTaskExecutionSummary {
  readonly stepId: string;
  readonly materialization: {
    readonly profile: {
      readonly id: string;
      readonly version: string;
      readonly sha256: string;
    } | null;
    readonly backend: string;
    readonly device: string;
    readonly precision: string;
    readonly mode: string;
    readonly resources: readonly string[];
    readonly origins: readonly ProjectRunTaskExecutionOrigin[];
  } | null;
}

function asRecord(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256
    ? value.trim()
    : null;
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

function requestedThreads(value: unknown): string | null {
  if (value === "auto") return "Auto";
  const count = positiveInteger(value);
  return count === null ? null : String(count);
}

function reservation(value: unknown): string | null {
  const resource = asRecord(value);
  if (!resource) return null;
  if (resource.reservation_bytes === undefined || resource.reservation_bytes === null) {
    return "not specified";
  }
  const bytes = nonNegativeInteger(resource.reservation_bytes);
  return bytes === null ? null : `${bytes} bytes`;
}

function parseResourceSummary(value: unknown): readonly string[] | null {
  const resources = asRecord(value);
  const target = asRecord(resources?.target);
  const cpu = asRecord(resources?.cpu);
  const parallelism = asRecord(resources?.parallelism);
  const targetKind = boundedString(target?.kind);
  const placement = boundedString(resources?.placement);
  const threads = requestedThreads(cpu?.threads);
  const nativeThreads = requestedThreads(cpu?.native_threads);
  const blasThreads = requestedThreads(cpu?.blas_threads);
  const affinity = boundedString(cpu?.affinity);
  const corePolicy = cpu?.core_policy === undefined || cpu.core_policy === null
    ? null
    : boundedString(cpu.core_policy);
  const numaNode = cpu?.numa_node === undefined || cpu.numa_node === null
    ? null
    : nonNegativeInteger(cpu.numa_node);
  const ram = reservation(resources?.ram);
  const scratch = reservation(resources?.scratch);

  if (
    !resources ||
    resources.schema_version !== "compute_resources.v1" ||
    targetKind === null ||
    !["local", "node", "pool"].includes(targetKind) ||
    ((targetKind === "node" || targetKind === "pool") && boundedString(target?.id) === null) ||
    placement === null || !["balanced", "throughput", "pinned"].includes(placement) ||
    threads === null || nativeThreads === null || blasThreads === null ||
    affinity === null || !["auto", "compact", "spread", "numa"].includes(affinity) ||
    (cpu?.core_policy !== undefined && cpu.core_policy !== null &&
      (corePolicy === null || !["physical_first", "logical"].includes(corePolicy))) ||
    (cpu?.numa_node !== undefined && cpu.numa_node !== null && numaNode === null) ||
    ram === null || scratch === null || !parallelism
  ) {
    return null;
  }

  let targetLabel = targetKind;
  if (targetKind === "node" || targetKind === "pool") {
    targetLabel += ` ${boundedString(target?.id)}`;
  }
  let cpuLabel = `CPU: ${threads} threads · native ${nativeThreads} · BLAS ${blasThreads} · affinity ${affinity}`;
  if (corePolicy) cpuLabel += ` · ${corePolicy}`;
  if (numaNode !== null) cpuLabel += ` · NUMA node ${numaNode}`;

  const summary = [`Target: ${targetLabel}`, cpuLabel];
  const gpuInput = resources.gpu;
  if (gpuInput !== undefined && gpuInput !== null) {
    const gpu = asRecord(gpuInput);
    const selector = boundedString(gpu?.selector);
    const devicesPerTask = positiveInteger(gpu?.devices_per_task);
    const uuidsInput = gpu?.device_uuids;
    const uuids = Array.isArray(uuidsInput)
      ? uuidsInput.map(boundedString)
      : null;
    const vramInput = gpu?.vram_per_device_bytes;
    const vramBytes = vramInput === undefined || vramInput === null
      ? null
      : nonNegativeInteger(vramInput);
    if (
      !gpu || selector === null ||
      !["any_compatible", "allow_list", "required"].includes(selector) ||
      devicesPerTask === null || uuids === null || uuids.some((uuid) => uuid === null) ||
      new Set(uuids).size !== uuids.length ||
      (vramInput !== undefined && vramInput !== null && vramBytes === null)
    ) return null;
    const uuidLabel = uuids.length > 0 ? ` · UUIDs ${uuids.join(", ")}` : "";
    const vramLabel = vramBytes === null ? "" : ` · ${vramBytes} bytes VRAM/device`;
    summary.push(`GPU: ${selector} · ${devicesPerTask} per task${uuidLabel}${vramLabel}`);
  } else {
    summary.push("GPU: no explicit resource selector");
  }
  summary.push(`RAM reservation: ${ram}`, `Scratch reservation: ${scratch}`);

  if (parallelism.kind === "single_process") {
    summary.push("Parallelism: single process");
  } else if (parallelism.kind === "distributed") {
    const ranks = positiveInteger(parallelism.ranks);
    const threadsPerRank = positiveInteger(parallelism.threads_per_rank);
    const ranksPerNode = positiveInteger(parallelism.ranks_per_node);
    const gpusPerRank = nonNegativeInteger(parallelism.gpus_per_rank);
    if (
      ranks === null || threadsPerRank === null || ranksPerNode === null ||
      ranksPerNode > ranks || gpusPerRank === null
    ) return null;
    summary.push(
      `Parallelism: ${ranks} ranks · ${threadsPerRank} threads/rank · ${ranksPerNode} ranks/node · ${gpusPerRank} GPUs/rank`,
    );
  } else {
    return null;
  }
  summary.push(`Placement: ${placement}`);
  return summary;
}

function parseOrigins(value: unknown): readonly ProjectRunTaskExecutionOrigin[] | null {
  const origins = asRecord(value);
  if (!origins || Object.keys(origins).length > 64) return null;

  const parsed: ProjectRunTaskExecutionOrigin[] = [];
  const entries = Object.entries(origins).sort(([left], [right]) => left.localeCompare(right));
  for (const [field, input] of entries) {
    const origin = asRecord(input);
    const kind = boundedString(origin?.kind);
    const location = boundedString(origin?.location);
    if (
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(field) ||
      kind === null ||
      !originKinds.has(kind) ||
      location === null
    ) {
      return null;
    }
    parsed.push({ field, kind, location });
  }
  return parsed;
}

export function parseProjectRunTaskExecution(input: unknown): ProjectRunTaskExecutionSummary | null {
  const execution = asRecord(asRecord(input)?.execution);
  const stepId = boundedString(execution?.step_id);
  if (!execution || stepId === null) return null;

  const materialization = asRecord(execution.materialization);
  if (!materialization) return { stepId, materialization: null };

  const profileInput = materialization.profile;
  const profile = asRecord(profileInput);
  const requested = asRecord(materialization.requested);
  const origins = parseOrigins(materialization.origins);
  const profileId = boundedString(profile?.profile_id);
  const profileVersion = boundedString(profile?.version);
  const profileShaInput = materialization.profile_sha256;
  const profileSha256 = boundedString(profileShaInput);
  const backend = boundedString(requested?.backend);
  const device = boundedString(requested?.device);
  const precision = boundedString(requested?.precision);
  const mode = boundedString(requested?.mode);
  const resources = parseResourceSummary(requested?.resources);

  if (
    materialization.schema_version !== "execution_request.v1" ||
    (profileInput !== undefined && profileInput !== null && profile === null) ||
    (profileShaInput !== undefined && profileShaInput !== null && profileSha256 === null) ||
    (profile === null) !== (profileSha256 === null) ||
    (profile !== null && profile?.schema_version !== "execution_profile.v1") ||
    (profile !== null && (profileId === null || profileVersion === null)) ||
    (profileSha256 !== null && !/^[a-f0-9]{64}$/.test(profileSha256)) ||
    backend === null ||
    device === null ||
    precision === null ||
    mode === null ||
    resources === null ||
    origins === null
  ) {
    return { stepId, materialization: null };
  }

  return {
    stepId,
    materialization: {
      profile: profileId && profileVersion && profileSha256
        ? { id: profileId, version: profileVersion, sha256: profileSha256 }
        : null,
      backend,
      device,
      precision,
      mode,
      resources,
      origins,
    },
  };
}
