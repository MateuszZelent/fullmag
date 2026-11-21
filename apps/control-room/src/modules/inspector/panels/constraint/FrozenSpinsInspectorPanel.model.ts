import type { FieldMetaResource, FrozenSpinsPreviewActivationResponse, FrozenSpinsSolverRuntimeStatus } from "@/kernel/api/apiTypes";

export function frozenSpinsPreviewTopologyFingerprint(
  fieldMeta: FieldMetaResource | null | undefined,
): string | null {
  const publicationFingerprint = fieldMeta?.publication_bundle?.topology_hash?.trim();
  if (publicationFingerprint) return publicationFingerprint;

  const currentCarriers = (fieldMeta?.resolved_capability?.carriers ?? []).filter(
    (carrier) =>
      carrier.payload_state === "current" && carrier.carrier_fingerprint.trim().length > 0,
  );
  const fullCarrier = currentCarriers.find(
    (carrier) => carrier.scope_kind === "full" && carrier.scope_id == null,
  );
  if (fullCarrier) return fullCarrier.carrier_fingerprint;

  const fingerprints = [...new Set(
    currentCarriers.map((carrier) => carrier.carrier_fingerprint),
  )];
  return fingerprints.length === 1 ? fingerprints[0] : null;
}

export interface FrozenSpinsSolverBindingModel {
  state: "confirmed" | "mismatch" | "not_committed" | "pending";
  message: string;
}

export function resolveFrozenSpinsSolverBinding(
  receipt: FrozenSpinsPreviewActivationResponse | null,
  runtime: FrozenSpinsSolverRuntimeStatus | null,
  constraintId: string,
): FrozenSpinsSolverBindingModel {
  if (!receipt) {
    return {
      state: "not_committed",
      message: "No authoring preview has been committed.",
    };
  }
  if (!runtime || !runtime.active_constraint_ids.includes(constraintId)) {
    return {
      state: "pending",
      message:
        "Waiting for a solver stage that activates this constraint and publishes its certificate.",
    };
  }
  const matches =
    runtime.constraint_activation_epochs[constraintId] !== undefined &&
    runtime.topology_fingerprint === receipt.topology_fingerprint &&
    (runtime.source_state_revision === null ||
      runtime.source_state_revision === receipt.source_state_revision) &&
    sameSha256Identity(runtime.mask_sha256, receipt.mask_sha256) &&
    sameSha256Identity(runtime.reference_sha256, receipt.reference_sha256) &&
    runtime.active_site_count === receipt.active_site_count &&
    runtime.frozen_site_count === receipt.frozen_site_count &&
    runtime.free_site_count === receipt.free_site_count;
  return matches
    ? {
        state: "confirmed",
        message: "Solver certificate matches the committed preview identity.",
      }
    : {
        state: "mismatch",
        message:
          "Solver recomputed a different activation identity. The speculative preview is invalid and the solver-owned quantity must be used.",
      };
}

function sameSha256Identity(left: string, right: string): boolean {
  return normalizeSha256Identity(left) === normalizeSha256Identity(right);
}

function normalizeSha256Identity(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, "");
}
