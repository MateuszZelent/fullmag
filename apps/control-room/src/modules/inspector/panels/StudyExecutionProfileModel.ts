import type {
  AuthoringTransactionRequest,
  ExecutionProfile,
  ExecutionRequestLayer,
  JsonObject,
  JsonValue,
} from "@/kernel/api/apiTypes";

export type StudyExecutionProfileOverrideKey =
  | "backend"
  | "device"
  | "precision"
  | "mode"
  | "cpuThreads";

export interface StudyExecutionProfileOverrides {
  backend: string;
  cpuThreads: string;
  device: string;
  mode: string;
  precision: string;
}

export interface StudyExecutionProfileDraft {
  invalidLayerData: boolean;
  invalidProfile: boolean;
  layers: JsonValue[];
  overrides: StudyExecutionProfileOverrides;
  profile: ExecutionProfile | null;
  touched: StudyExecutionProfileOverrideKey[];
}

export interface StudyExecutionProfileAssignment {
  execution_layers: ExecutionRequestLayer[] | null;
  execution_profile: ExecutionProfile | null;
}

export const EMPTY_STUDY_EXECUTION_PROFILE_OVERRIDES: StudyExecutionProfileOverrides = {
  backend: "",
  cpuThreads: "",
  device: "",
  mode: "",
  precision: "",
};

export function createStudyExecutionProfileDraft(
  scene: unknown,
): StudyExecutionProfileDraft {
  const study = asRecord(asRecord(scene)?.study);
  const rawProfile = study?.execution_profile;
  const profile = isExecutionProfile(rawProfile) ? rawProfile : null;
  const rawLayers = study?.execution_layers;
  const invalidLayerData =
    rawLayers !== undefined &&
    rawLayers !== null &&
    (!Array.isArray(rawLayers) ||
      !rawLayers.every(isJsonValue) ||
      !rawLayers.every(isExecutionRequestLayer));
  const layers = Array.isArray(rawLayers) && rawLayers.every(isJsonValue)
    ? structuredClone(rawLayers)
    : [];

  return {
    invalidLayerData,
    invalidProfile: rawProfile !== undefined && rawProfile !== null && !profile,
    layers,
    overrides: readStudyOverrides(layers),
    profile,
    touched: [],
  };
}

export function hasStudyExecutionProfile(scene: unknown): boolean {
  const study = asRecord(asRecord(scene)?.study);
  return study?.execution_profile !== undefined && study.execution_profile !== null;
}

export function hasChangeDeviceStudyStage(
  scene: unknown,
  stages: readonly unknown[],
): boolean {
  if (stages.some((stage) => {
    const record = asRecord(stage);
    const kind = record?.kind;
    const entrypoint = record?.entrypoint_kind;
    return equalsKind(kind, "change_device") || equalsKind(entrypoint, "flat_change_device");
  })) {
    return true;
  }

  const study = asRecord(asRecord(scene)?.study);
  const pipeline = asRecord(study?.study_pipeline);
  return hasChangeDevicePipelineNode(pipeline?.nodes);
}

export function updateStudyExecutionProfileOverride(
  draft: StudyExecutionProfileDraft,
  key: StudyExecutionProfileOverrideKey,
  value: string,
): StudyExecutionProfileDraft {
  return {
    ...draft,
    overrides: { ...draft.overrides, [key]: value },
    touched: draft.touched.includes(key)
      ? draft.touched
      : [...draft.touched, key],
  };
}

export function selectStudyExecutionProfile(
  draft: StudyExecutionProfileDraft,
  profile: ExecutionProfile | null,
): StudyExecutionProfileDraft {
  return {
    ...draft,
    invalidProfile: false,
    invalidLayerData: profile === null ? false : draft.invalidLayerData,
    profile,
  };
}

export function studyExecutionProfileDraftIsDirty(
  draft: StudyExecutionProfileDraft,
  baseline: StudyExecutionProfileDraft,
): boolean {
  return (
    profileFingerprint(draft.profile) !== profileFingerprint(baseline.profile) ||
    draft.touched.length > 0 ||
    draft.invalidLayerData !== baseline.invalidLayerData ||
    draft.invalidProfile !== baseline.invalidProfile
  );
}

export function resetStudyExecutionProfileDraft(
  draft: StudyExecutionProfileDraft,
): StudyExecutionProfileDraft {
  return {
    ...draft,
    overrides: { ...draft.overrides },
    touched: [],
  };
}

export function validateStudyExecutionProfileDraft(
  draft: StudyExecutionProfileDraft,
): string | null {
  if (draft.profile === null) return null;
  if (draft.invalidProfile) {
    return "The stored profile snapshot is malformed. Clear it or restore a valid immutable profile version.";
  }
  if (draft.invalidLayerData) {
    return "The stored execution layers are malformed. Clear the profile before replacing them.";
  }
  if (draft.overrides.cpuThreads.trim()) {
    const value = draft.overrides.cpuThreads.trim();
    const threads = Number(value);
    if (
      value !== "auto" &&
      (!/^\d+$/.test(value) ||
        !Number.isSafeInteger(threads) ||
        threads <= 0 ||
        threads > 4_294_967_295)
    ) {
      return "CPU threads must be Inherit, Auto, or a positive integer.";
    }
  }
  if (
    draft.touched.length > 0 &&
    studyLayerIndexes(draft.layers).length > 1
  ) {
    return "This scene has multiple Study execution layers. Keep the draft and resolve them before editing Study overrides.";
  }
  return null;
}

export function buildStudyExecutionProfileAssignment(
  draft: StudyExecutionProfileDraft,
): StudyExecutionProfileAssignment {
  if (draft.profile === null) {
    return { execution_profile: null, execution_layers: null };
  }
  const validationError = validateStudyExecutionProfileDraft(draft);
  if (validationError) throw new Error(validationError);

  const layers = draft.touched.length > 0
    ? updateStudyLayer(draft.layers, draft.overrides, draft.touched)
    : structuredClone(draft.layers);
  if (!layers.every(isExecutionRequestLayer)) {
    throw new Error(
      "An execution layer is malformed. Its data was preserved; clear the profile only if you intend to remove it.",
    );
  }
  return {
    execution_profile: draft.profile,
    execution_layers: layers,
  };
}

export function buildStudyExecutionProfileMergePatch(
  draft: StudyExecutionProfileDraft,
  baseRevision: number,
): AuthoringTransactionRequest {
  const assignment = buildStudyExecutionProfileAssignment(draft);
  return buildStudyExecutionProfileAssignmentMergePatch(assignment, baseRevision);
}

export function buildStudyExecutionProfileAssignmentMergePatch(
  assignment: StudyExecutionProfileAssignment,
  baseRevision: number,
): AuthoringTransactionRequest {
  if (assignment.execution_profile !== null) {
    if (assignment.execution_layers === null) {
      throw new Error("An assigned execution profile requires a typed layer list.");
    }
    return {
      base_revision: baseRevision,
      execution_layers: assignment.execution_layers,
      execution_profile: assignment.execution_profile,
      kind: "assign_study_execution",
    };
  }
  const study: JsonObject = {
    execution_profile: null,
    execution_layers: null,
  };
  return {
    base_revision: baseRevision,
    kind: "merge_patch",
    merge_patch: { study },
  };
}

export function studyExecutionProfileKey(profile: ExecutionProfile): string {
  return JSON.stringify([profile.profile_id, profile.version]);
}

export function sameStudyExecutionProfile(
  left: ExecutionProfile | null,
  right: ExecutionProfile | null,
): boolean {
  return profileFingerprint(left) === profileFingerprint(right);
}

function updateStudyLayer(
  sourceLayers: readonly JsonValue[],
  overrides: StudyExecutionProfileOverrides,
  touched: readonly StudyExecutionProfileOverrideKey[],
): JsonValue[] {
  const layers = structuredClone([...sourceLayers]);
  const indexes = studyLayerIndexes(layers);
  if (indexes.length > 1) {
    throw new Error(
      "This scene has multiple Study execution layers. Keep the draft and resolve them before editing Study overrides.",
    );
  }

  const layerIndex = indexes[0];
  const sourceLayer = layerIndex === undefined ? null : asRecord(layers[layerIndex]);
  const sourceRequest = asRecord(sourceLayer?.request);
  const request: JsonObject = sourceRequest
    ? cloneJsonRecord(sourceRequest)
    : {};

  for (const key of touched) {
    if (key === "cpuThreads") continue;
    const sceneKey = key === "backend" ? "backend" : key;
    const value = overrides[key];
    if (value.trim()) request[sceneKey] = value;
    else delete request[sceneKey];
  }

  if (touched.includes("cpuThreads")) {
    const resourcesValue = request.resources;
    if (resourcesValue !== undefined && !isJsonObject(resourcesValue)) {
      throw new Error(
        "The existing Study layer has non-object resource settings. Its CPU thread override was not changed.",
      );
    }
    const resources = isJsonObject(resourcesValue)
      ? cloneJsonRecord(resourcesValue)
      : {};
    const cpuValue = resources.cpu;
    if (cpuValue !== undefined && !isJsonObject(cpuValue)) {
      throw new Error(
        "The existing Study layer has non-object CPU resource settings. Its CPU thread override was not changed.",
      );
    }
    const cpu = isJsonObject(cpuValue) ? cloneJsonRecord(cpuValue) : {};
    const threadText = overrides.cpuThreads.trim();
    if (!threadText) delete cpu.threads;
    else if (threadText === "auto") cpu.threads = "auto";
    else cpu.threads = Number(threadText);
    if (Object.keys(cpu).length > 0) resources.cpu = cpu;
    else delete resources.cpu;
    if (Object.keys(resources).length > 0) request.resources = resources;
    else delete request.resources;
  }

  if (layerIndex === undefined) {
    if (Object.keys(request).length === 0) return layers;
    layers.push({
      origin: { kind: "study", location: "Study execution profile" },
      request,
    });
    return layers;
  }

  const layer = cloneJsonRecord(sourceLayer ?? {});
  layer.request = request;
  layers[layerIndex] = layer;
  return layers;
}

function readStudyOverrides(layers: readonly JsonValue[]): StudyExecutionProfileOverrides {
  const firstLayerIndex = studyLayerIndexes(layers)[0];
  if (firstLayerIndex === undefined) {
    return { ...EMPTY_STUDY_EXECUTION_PROFILE_OVERRIDES };
  }
  const request = asRecord(asRecord(layers[firstLayerIndex])?.request);
  const resources = asRecord(request?.resources);
  const cpu = asRecord(resources?.cpu);
  return {
    backend: scalarText(request?.backend),
    cpuThreads: scalarText(cpu?.threads),
    device: scalarText(request?.device),
    mode: scalarText(request?.mode),
    precision: scalarText(request?.precision),
  };
}

function studyLayerIndexes(layers: readonly JsonValue[]): number[] {
  const indexes: number[] = [];
  layers.forEach((layer, index) => {
    const origin = asRecord(asRecord(layer)?.origin);
    if (origin?.kind === "study") indexes.push(index);
  });
  return indexes;
}

function scalarText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function profileFingerprint(profile: ExecutionProfile | null): string {
  return profile === null ? "null" : JSON.stringify(profile);
}

function isExecutionProfile(value: unknown): value is ExecutionProfile {
  const profile = asRecord(value);
  return Boolean(
    profile &&
      profile.schema_version === "execution_profile.v1" &&
      typeof profile.profile_id === "string" &&
      typeof profile.version === "string" &&
      typeof profile.description === "string" &&
      isJsonObject(profile.defaults),
  );
}

function isExecutionRequestLayer(value: unknown): value is ExecutionRequestLayer {
  const layer = asRecord(value);
  const origin = asRecord(layer?.origin);
  if (
    !layer ||
    !origin ||
    !hasOnlyKeys(layer, ["origin", "request"]) ||
    !hasOnlyKeys(origin, ["kind", "location"]) ||
    !isOneOf(origin.kind, ["script", "study", "step", "submit", "cli", "legacy_env"]) ||
    typeof origin.location !== "string" ||
    !origin.location.trim()
  ) {
    return false;
  }
  return layer.request === undefined || isExecutionRequestPatch(layer.request);
}

function isExecutionRequestPatch(value: unknown): boolean {
  const request = asRecord(value);
  if (!request || !hasOnlyKeys(request, ["backend", "device", "precision", "mode", "resources"])) {
    return false;
  }
  if (request.backend !== undefined && !isOneOf(request.backend, ["auto", "fdm", "fem", "hybrid"])) return false;
  if (request.device !== undefined && !isOneOf(request.device, ["auto", "cpu", "gpu"])) return false;
  if (request.precision !== undefined && !isOneOf(request.precision, ["single", "double"])) return false;
  if (request.mode !== undefined && !isOneOf(request.mode, ["strict", "extended", "hybrid"])) return false;
  return request.resources === undefined || isComputeResourcePatch(request.resources);
}

function isComputeResourcePatch(value: unknown): boolean {
  const resources = asRecord(value);
  if (
    !resources ||
    !hasOnlyKeys(resources, ["target", "cpu", "gpu", "ram", "scratch", "parallelism", "placement"])
  ) {
    return false;
  }
  if (resources.target !== undefined && !isComputeTarget(resources.target)) return false;
  if (resources.cpu !== undefined && !isCpuResourcePatch(resources.cpu)) return false;
  if (resources.gpu !== undefined && resources.gpu !== null && !isGpuResources(resources.gpu)) return false;
  if (resources.ram !== undefined && resources.ram !== null && !isMemoryPatch(resources.ram)) return false;
  if (resources.scratch !== undefined && resources.scratch !== null && !isMemoryPatch(resources.scratch)) return false;
  if (resources.parallelism !== undefined && resources.parallelism !== null && !isParallelism(resources.parallelism)) return false;
  return resources.placement === undefined || resources.placement === null || isOneOf(resources.placement, ["balanced", "throughput", "pinned"]);
}

function isComputeTarget(value: unknown): boolean {
  const target = asRecord(value);
  if (!target) return false;
  if (target.kind === "local") return hasOnlyKeys(target, ["kind"]);
  return (
    (target.kind === "node" || target.kind === "pool") &&
    typeof target.id === "string" &&
    Boolean(target.id.trim()) &&
    hasOnlyKeys(target, ["kind", "id"])
  );
}

function isCpuResourcePatch(value: unknown): boolean {
  const cpu = asRecord(value);
  if (!cpu || !hasOnlyKeys(cpu, ["threads", "core_policy", "affinity", "numa_node", "native_threads", "blas_threads"])) return false;
  for (const key of ["threads", "native_threads", "blas_threads"] as const) {
    if (cpu[key] !== undefined && !isRequestedThreads(cpu[key])) return false;
  }
  if (cpu.core_policy !== undefined && cpu.core_policy !== null && !isOneOf(cpu.core_policy, ["physical_first", "logical"])) return false;
  if (cpu.affinity !== undefined && !isOneOf(cpu.affinity, ["auto", "compact", "spread", "numa"])) return false;
  return cpu.numa_node === undefined || cpu.numa_node === null || isU32(cpu.numa_node, true);
}

function isGpuResources(value: unknown): boolean {
  const gpu = asRecord(value);
  return Boolean(
    gpu &&
      hasOnlyKeys(gpu, ["selector", "device_uuids", "devices_per_task", "vram_per_device_bytes"]) &&
      (gpu.selector === undefined || isOneOf(gpu.selector, ["any_compatible", "allow_list", "required"])) &&
      (gpu.device_uuids === undefined || (Array.isArray(gpu.device_uuids) && gpu.device_uuids.every((id) => typeof id === "string"))) &&
      (gpu.devices_per_task === undefined || isU32(gpu.devices_per_task)) &&
      (gpu.vram_per_device_bytes === undefined || gpu.vram_per_device_bytes === null || isPositiveSafeInteger(gpu.vram_per_device_bytes)),
  );
}

function isMemoryPatch(value: unknown): boolean {
  const memory = asRecord(value);
  return Boolean(
    memory &&
      hasOnlyKeys(memory, ["reservation_bytes"]) &&
      (memory.reservation_bytes === undefined || memory.reservation_bytes === null || isPositiveSafeInteger(memory.reservation_bytes)),
  );
}

function isParallelism(value: unknown): boolean {
  const parallelism = asRecord(value);
  if (!parallelism) return false;
  if (parallelism.kind === "single_process") return hasOnlyKeys(parallelism, ["kind"]);
  return (
    parallelism.kind === "distributed" &&
    hasOnlyKeys(parallelism, ["kind", "ranks", "threads_per_rank", "ranks_per_node", "gpus_per_rank"]) &&
    isU32(parallelism.ranks) &&
    isU32(parallelism.threads_per_rank) &&
    isU32(parallelism.ranks_per_node) &&
    isU32(parallelism.gpus_per_rank, true)
  );
}

function isRequestedThreads(value: unknown): boolean {
  return value === "auto" || isU32(value);
}

function isU32(value: unknown, allowZero = false): boolean {
  return Number.isSafeInteger(value) &&
    (value as number) <= 4_294_967_295 &&
    (value as number) >= (allowZero ? 0 : 1);
}

function isPositiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.includes(value as T);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

function hasChangeDevicePipelineNode(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((rawNode) => {
    const node = asRecord(rawNode);
    if (!node) return false;
    const payload = asRecord(node.payload);
    const isDeviceChange =
      equalsKind(node.stage_kind, "change_device") ||
      equalsKind(payload?.kind, "change_device");
    return isDeviceChange || hasChangeDevicePipelineNode(node.children);
  });
}

function equalsKind(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === expected;
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.values(value).every(isJsonValue),
  );
}

function cloneJsonRecord(value: Record<string, unknown>): JsonObject {
  return structuredClone(value) as JsonObject;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
