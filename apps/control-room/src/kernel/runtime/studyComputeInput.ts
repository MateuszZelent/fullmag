import type { LiveStatusResource, RuntimeCommandPrecondition } from "../api/apiTypes";

const REGION_REVISIONS = [
  ["region_topology_revision", "region topology revision"],
  ["region_membership_revision", "region membership revision"],
  ["region_coefficients_revision", "region coefficients revision"],
  ["region_initial_state_revision", "region initial state revision"],
] as const;

type ComputeStatus = {
  resources: Pick<
    LiveStatusResource["resources"],
    "scene_revision" | "mesh_revision" | "domain_generation_id" | typeof REGION_REVISIONS[number][0]
  >;
  run?: LiveStatusResource["run"];
};

export function regionRevisionPrecondition(
  status: ComputeStatus | null,
): RuntimeCommandPrecondition {
  const precondition: RuntimeCommandPrecondition = {};
  for (const [key] of REGION_REVISIONS) {
    const revision = status?.resources[key];
    if (typeof revision === "number") precondition[key] = revision;
  }
  return precondition;
}

function numericRevision(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function captureStudyComputeInput(status: ComputeStatus): RuntimeCommandPrecondition {
  const { resources, run } = status;
  return {
    ...regionRevisionPrecondition(status),
    scene_revision: numericRevision(resources.scene_revision),
    mesh_revision: numericRevision(resources.mesh_revision),
    ...(resources.domain_generation_id ? { domain_generation_id: resources.domain_generation_id } : {}),
    current_run: run ? { kind: "run", run_id: run.run_id } : { kind: "none" },
  };
}

export function changedStudyComputeInput(
  original: RuntimeCommandPrecondition,
  status: ComputeStatus,
): string | null {
  const revisions = [
    ["scene_revision", "scene revision"],
    ["mesh_revision", "mesh revision"],
    ["domain_generation_id", "domain generation"],
    ...REGION_REVISIONS,
  ] as const;
  for (const [key, label] of revisions) {
    if (original[key] != null && original[key] !== status.resources[key]) return label;
  }
  if (original.current_run) {
    const expected = original.current_run.kind === "run" ? original.current_run.run_id : null;
    if ((status.run?.run_id ?? null) !== expected) return "current run";
  }
  return null;
}
