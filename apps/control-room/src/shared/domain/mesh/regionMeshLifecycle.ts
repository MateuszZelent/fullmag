import type {
  MeshActiveBuildResource,
  MeshRegionMembershipResource,
} from "@/kernel/api/apiTypes";

export type RegionMeshLifecycleStatus =
  | "configured"
  | "draft"
  | "pending"
  | "current"
  | "stale"
  | "failed"
  | "unsupported";

export interface RegionMeshLifecycleInput {
  build: MeshActiveBuildResource | null | undefined;
  draftDirty: boolean;
  membership: MeshRegionMembershipResource | null | undefined;
  policyEnabled: boolean;
  supported: boolean;
}

export interface RegionMeshLifecycle {
  generationId: string | null;
  membershipRevision: number | null;
  reason: string;
  status: RegionMeshLifecycleStatus;
  topologyFingerprint: string | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasActiveBuild(build: MeshActiveBuildResource | null | undefined): boolean {
  if (!build) return false;
  const activeBuild = build.active_build as unknown;
  if (
    activeBuild &&
    typeof activeBuild === "object" &&
    !Array.isArray(activeBuild) &&
    Object.keys(activeBuild).length > 0
  ) {
    return true;
  }
  return (build.mesh_pipeline_status ?? []).some((phase) => {
    const status = phase.status?.toLowerCase();
    return status === "building" || status === "pending" || status === "queued" || status === "running";
  });
}

function hasCertifiedMembership(
  membership: MeshRegionMembershipResource | null | undefined,
): boolean {
  return Boolean(
    membership &&
      typeof membership.freshness === "string" &&
      membership.freshness.toLowerCase() === "current" &&
      typeof membership.realization === "string" &&
      membership.realization.toLowerCase() === "conformal" &&
      nonEmptyString(membership.mesh_generation_id) &&
      nonEmptyString(membership.topology_fingerprint),
  );
}

export function resolveRegionMeshLifecycle(
  input: RegionMeshLifecycleInput,
): RegionMeshLifecycle {
  const membership = input.membership;
  const generationId = nonEmptyString(membership?.mesh_generation_id);
  const topologyFingerprint = nonEmptyString(membership?.topology_fingerprint);
  const membershipRevision = membership?.region_membership_revision ?? null;

  if (!input.supported) {
    return {
      generationId,
      membershipRevision,
      reason: "Region mesh policy is not supported by the resolved backend capability.",
      status: "unsupported",
      topologyFingerprint,
    };
  }
  if (input.draftDirty) {
    return {
      generationId,
      membershipRevision,
      reason: "Unapplied region mesh policy changes.",
      status: "draft",
      topologyFingerprint,
    };
  }
  if (hasActiveBuild(input.build)) {
    return {
      generationId,
      membershipRevision,
      reason: "A mesh build is pending or running.",
      status: "pending",
      topologyFingerprint,
    };
  }
  const buildError = nonEmptyString(input.build?.last_build_error);
  if (buildError) {
    return {
      generationId,
      membershipRevision,
      reason: buildError,
      status: "failed",
      topologyFingerprint,
    };
  }
  if (hasCertifiedMembership(membership)) {
    return {
      generationId,
      membershipRevision,
      reason: "Certified conformal mesh membership is current.",
      status: "current",
      topologyFingerprint,
    };
  }
  if (!input.policyEnabled && !membership) {
    return {
      generationId: null,
      membershipRevision: null,
      reason: "Region inherits the object mesh policy.",
      status: "configured",
      topologyFingerprint: null,
    };
  }
  return {
    generationId,
    membershipRevision,
    reason: membership
      ? "Realized region membership is stale or lacks a certified conformal identity."
      : "No realized mesh membership is available for this region.",
    status: "stale",
    topologyFingerprint,
  };
}
