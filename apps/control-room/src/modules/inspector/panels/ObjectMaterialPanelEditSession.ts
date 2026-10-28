import type { InspectorEditSession } from "../InspectorEditSession";

export const OBJECT_MATERIAL_MULTIPLE_DRAFTS_BLOCK_REASON =
  "Apply or revert one draft before committing the other; these changes use separate server writes.";

export interface ObjectMaterialMutationLease {
  readonly operation: string;
  readonly scopeKey: string;
  readonly token: symbol;
}

export interface ObjectMaterialMutationCoordinator {
  acquire: (scopeKey: string, operation: string) => ObjectMaterialMutationLease | null;
  finish: (lease: ObjectMaterialMutationLease) => boolean;
  getActive: (scopeKey: string) => ObjectMaterialMutationLease | null;
  getVersion: () => number;
  subscribe: (listener: () => void) => () => void;
}

/** A panel-owned synchronous lock shared by material and boundary writers. */
export function createObjectMaterialMutationCoordinator(): ObjectMaterialMutationCoordinator {
  const active = new Map<string, ObjectMaterialMutationLease>();
  const listeners = new Set<() => void>();
  let version = 0;

  function publish(): void {
    version += 1;
    listeners.forEach((listener) => listener());
  }

  return Object.freeze({
    acquire: (scopeKey: string, operation: string) => {
      if (active.has(scopeKey)) return null;
      const lease = Object.freeze({
        operation,
        scopeKey,
        token: Symbol(operation),
      });
      active.set(scopeKey, lease);
      publish();
      return lease;
    },
    finish: (lease: ObjectMaterialMutationLease) => {
      if (active.get(lease.scopeKey)?.token !== lease.token) return false;
      active.delete(lease.scopeKey);
      publish();
      return true;
    },
    getActive: (scopeKey: string) => active.get(scopeKey) ?? null,
    getVersion: () => version,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

/** Shared by every material and absorbing-boundary writer in this client. */
export const objectMaterialMutationCoordinator = createObjectMaterialMutationCoordinator();

export function objectMaterialMutationScopeKey(
  sessionScopeKey: string | null,
  objectId: string,
): string {
  return `${sessionScopeKey ?? "session:unknown"}|${objectId}`;
}

export type ObjectMaterialDraftScope = "anisotropy" | "assignment" | "parameters";

const OBJECT_MATERIAL_DRAFT_APPLY_LABELS: Record<ObjectMaterialDraftScope, string> = {
  anisotropy: "Apply Anisotropy",
  assignment: "Apply Assignment",
  parameters: "Apply Parameters",
};

export interface ObjectMaterialDraftApplyPolicy {
  applyBlockReason?: string;
  directApplyFailureReason?: string;
}

/**
 * Keep independent material writes separate. When a selection hides one of
 * the required local Apply actions, explain that the draft must be reverted
 * before switching views. Never let its callback start a partial write.
 */
export function resolveObjectMaterialDraftApplyPolicy(
  dirtyScopes: readonly ObjectMaterialDraftScope[],
  availableScopes: ReadonlySet<ObjectMaterialDraftScope>,
): ObjectMaterialDraftApplyPolicy {
  const uniqueDirtyScopes = [...new Set(dirtyScopes)];
  if (uniqueDirtyScopes.length < 2) return {};

  const hiddenScopes = uniqueDirtyScopes.filter((scope) => !availableScopes.has(scope));
  if (hiddenScopes.length > 0) {
    const hiddenActions = hiddenScopes
      .map((scope) => OBJECT_MATERIAL_DRAFT_APPLY_LABELS[scope])
      .join(", ");
    const failureReason =
      `This selection has multiple dirty material drafts, but hides ${hiddenActions}. ` +
      "No safe Apply path is available here. Revert before switching to a view that exposes each draft's Apply action.";
    return { applyBlockReason: failureReason, directApplyFailureReason: failureReason };
  }

  const hasAssignmentAndParameters =
    uniqueDirtyScopes.includes("assignment") && uniqueDirtyScopes.includes("parameters");
  const labels = uniqueDirtyScopes
    .map((scope) => OBJECT_MATERIAL_DRAFT_APPLY_LABELS[scope])
    .join(" and ");
  const applyBlockReason = hasAssignmentAndParameters
    ? "Apply Assignment first and wait until the assigned material loads. Then use Apply Parameters." +
      (uniqueDirtyScopes.includes("anisotropy")
        ? " Wait for that acknowledgement, then use Apply Anisotropy as a separate write."
        : "")
    : `Use ${labels} as separate writes, waiting for each server acknowledgement before starting the next.`;

  return {
    applyBlockReason,
    directApplyFailureReason: applyBlockReason,
  };
}

/**
 * Route Inspector Apply to the only dirty draft. Two independently acknowledged
 * authoring writes cannot be presented as one atomic transaction.
 */
export function combineObjectMaterialEditSessions(
  material: InspectorEditSession,
  absorbingBoundary: InspectorEditSession | null,
): InspectorEditSession {
  const materialDirty = material.dirty;
  const boundaryDirty = absorbingBoundary?.dirty ?? false;
  const bothDirty = materialDirty && boundaryDirty;
  const onlyDirtyOwner = boundaryDirty ? absorbingBoundary : material;

  return {
    applyBlockReason: bothDirty
      ? [
          OBJECT_MATERIAL_MULTIPLE_DRAFTS_BLOCK_REASON,
          material.applyBlockReason,
          absorbingBoundary?.applyBlockReason,
        ].filter((reason): reason is string => Boolean(reason)).join(" ")
      : onlyDirtyOwner?.applyBlockReason,
    apply: async () => {
      if (bothDirty || (!materialDirty && !boundaryDirty)) return false;
      const owner = boundaryDirty ? absorbingBoundary : material;
      if (!owner) return false;
      return (await owner.apply()) === true;
    },
    applying: material.applying || (absorbingBoundary?.applying ?? false),
    dirty: materialDirty || boundaryDirty,
    lockReason: material.lockReason ?? (boundaryDirty ? absorbingBoundary?.lockReason : undefined),
    mode: material.mode,
    reset: async () => {
      const resetOwners = [
        ...(materialDirty ? [() => material.reset()] : []),
        ...(boundaryDirty && absorbingBoundary ? [() => absorbingBoundary.reset()] : []),
      ];
      const results = await Promise.allSettled(
        resetOwners.map((reset) => Promise.resolve().then(reset)),
      );
      if (results.some((result) => result.status === "rejected")) {
        throw new Error("Revert did not reset every dirty Inspector draft.");
      }
    },
    valid: bothDirty
      ? material.valid && (absorbingBoundary?.valid ?? false)
      : (onlyDirtyOwner?.valid ?? material.valid),
  };
}
