import type { MeshCapabilitiesResource } from "@/kernel/api/apiTypes";

export type MeshEditorDiscretization = "fdm" | "fem";
export type MeshEditorDevice = "cpu" | "gpu";
export type MeshEditorPrecision = "single" | "double";
export type MeshEditorCapabilityId =
  | MeshEditorDiscretization
  | MeshEditorDevice
  | MeshEditorPrecision
  | "multilayer"
  | "pbc";

export type MeshEditorCapabilityStatus =
  | "supported"
  | "reference_executable"
  | "partial_production_executable"
  | "production_executable"
  | "validated"
  | "development_executable"
  | "semantic_only"
  | "source_visible"
  | "unsupported"
  | "unavailable";

export interface MeshEditorCapabilityOption {
  id: MeshEditorCapabilityId;
  enabled: boolean;
  reason: string | null;
  status: MeshEditorCapabilityStatus;
}

export type MeshEditorCapabilityResourceLike = Pick<
  MeshCapabilitiesResource,
  "mesh_capabilities" | "mesh_adaptivity_state"
>;

export interface MeshEditorDraft {
  discretization: MeshEditorDiscretization;
  device: MeshEditorDevice;
  precision: MeshEditorPrecision;
  multilayer: boolean;
  periodic: boolean;
}

export interface MeshEditorPatch {
  discretization: MeshEditorDiscretization;
  device: MeshEditorDevice;
  precision: MeshEditorPrecision;
  multilayer: boolean;
  pbc: { enabled: boolean };
}

export interface MeshEditorCapabilityModel {
  readonly options: readonly MeshEditorCapabilityOption[];
  option(id: MeshEditorCapabilityId): MeshEditorCapabilityOption;
}

/**
 * A missing/unpublished lane is informational until the server advertises a
 * definitive unsupported status. This keeps older runtime bundles usable while
 * still making explicit capability rejections fail closed.
 */
export function meshEditorCapabilityBlocks(
  option: MeshEditorCapabilityOption,
): boolean {
  return option.status !== "unavailable" && !option.enabled;
}

const EXECUTABLE_STATUSES = new Set<MeshEditorCapabilityStatus>([
  "supported",
  "reference_executable",
  "partial_production_executable",
  "production_executable",
  "validated",
]);

const CAPABILITY_IDS: readonly MeshEditorCapabilityId[] = [
  "fdm",
  "fem",
  "cpu",
  "gpu",
  "single",
  "double",
  "multilayer",
  "pbc",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    current = asRecord(current)?.[key];
    if (current === undefined) return undefined;
  }
  return current;
}

function statusOf(value: unknown): MeshEditorCapabilityStatus | null {
  if (typeof value === "boolean") return value ? "supported" : "unsupported";
  const status = asRecord(value)?.status;
  if (typeof status !== "string") return null;
  if (
    status === "supported" ||
    status === "reference_executable" ||
    status === "partial_production_executable" ||
    status === "production_executable" ||
    status === "validated" ||
    status === "development_executable" ||
    status === "semantic_only" ||
    status === "source_visible" ||
    status === "unsupported" ||
    status === "unavailable"
  ) {
    return status;
  }
  return null;
}

function reasonOf(value: unknown): string | null {
  const record = asRecord(value);
  for (const key of ["reason", "capability_reason", "disabled_reason"]) {
    const reason = record?.[key];
    if (typeof reason === "string" && reason.trim().length > 0) {
      return reason;
    }
  }
  return null;
}

function resolveValue(
  capabilities: unknown,
  id: MeshEditorCapabilityId,
): unknown {
  const paths: Record<MeshEditorCapabilityId, readonly (readonly string[])[]> = {
    fdm: [["fdm"], ["backends", "fdm"], ["supports_fdm"]],
    fem: [["fem"], ["backends", "fem"], ["supports_fem"]],
    cpu: [["cpu"], ["devices", "cpu"], ["supports_cpu"]],
    gpu: [["gpu"], ["devices", "gpu"], ["supports_gpu"]],
    single: [["single"], ["precision", "single"], ["supports_single_precision"]],
    double: [["double"], ["precision", "double"], ["supports_double_precision"]],
    multilayer: [["multilayer"], ["supports_multilayer"]],
    pbc: [["pbc"], ["periodic"], ["supports_pbc"], ["supports_periodic"]],
  };
  for (const path of paths[id]) {
    const value = readPath(capabilities, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

function resolveOption(
  capabilities: unknown,
  id: MeshEditorCapabilityId,
  resourceAvailable: boolean,
): MeshEditorCapabilityOption {
  if (!resourceAvailable) {
    return {
      id,
      enabled: false,
      reason: "Meshing capability resource is unavailable.",
      status: "unavailable",
    };
  }

  const value = resolveValue(capabilities, id);
  const status = statusOf(value) ?? "unavailable";
  const reason =
    reasonOf(value) ??
    (status === "unsupported"
      ? `Capability ${id} is not advertised for this lane.`
      : status === "unavailable"
        ? `Capability ${id} is not advertised by the meshing resource.`
        : null);
  return {
    id,
    enabled: EXECUTABLE_STATUSES.has(status),
    reason,
    status,
  };
}

export function resolveMeshEditorCapabilities(
  resource: MeshEditorCapabilityResourceLike | null | undefined,
): MeshEditorCapabilityModel {
  const resourceAvailable = resource !== null && resource !== undefined;
  const capabilities = resource?.mesh_capabilities;
  const options = CAPABILITY_IDS.map((id) =>
    resolveOption(capabilities, id, resourceAvailable),
  );
  return {
    options,
    option(id) {
      return options.find((option) => option.id === id) ?? {
        id,
        enabled: false,
        reason: "Capability is not part of the mesh editor matrix.",
        status: "unavailable",
      };
    },
  };
}

export function buildMeshEditorPatch(
  draft: MeshEditorDraft,
  capabilities: MeshEditorCapabilityModel,
): { patch: MeshEditorPatch } | { error: string } {
  const required: MeshEditorCapabilityId[] = [
    draft.discretization,
    draft.device,
    draft.precision,
  ];
  if (draft.multilayer) required.push("multilayer");
  if (draft.periodic) required.push("pbc");

  for (const id of required) {
    const option = capabilities.option(id);
    if (!option.enabled) {
      return {
        error: option.reason ?? `Capability ${id} is unavailable.`,
      };
    }
  }

  return {
    patch: {
      discretization: draft.discretization,
      device: draft.device,
      precision: draft.precision,
      multilayer: draft.multilayer,
      pbc: { enabled: draft.periodic },
    },
  };
}
