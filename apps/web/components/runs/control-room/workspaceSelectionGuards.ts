export interface WorkspaceSelectionLike {
  selected_node_id?: string | null;
  selected_object_id?: string | null;
  selected_entity_id?: string | null;
}

export function workspaceSelectionIdentity(
  value: WorkspaceSelectionLike | null | undefined,
): string {
  return JSON.stringify([
    value?.selected_node_id ?? null,
    value?.selected_object_id ?? null,
    value?.selected_entity_id ?? null,
  ]);
}

export type RemoteWorkspaceSelectionHydrationDecision =
  | { kind: "noop" }
  | { kind: "confirm-pending" }
  | { kind: "apply" }
  | { kind: "reject-stale-pending" };

export function resolveRemoteWorkspaceSelectionHydration(args: {
  remoteIdentity: string;
  currentIdentity: string;
  pendingIdentity: string | null;
}): RemoteWorkspaceSelectionHydrationDecision {
  if (args.remoteIdentity === args.currentIdentity) {
    if (args.pendingIdentity) {
      return { kind: "confirm-pending" };
    }
    return { kind: "noop" };
  }
  if (args.pendingIdentity && args.remoteIdentity !== args.pendingIdentity) {
    return { kind: "reject-stale-pending" };
  }
  return { kind: "apply" };
}

export function resolvePersistedWorkspaceSelection(args: {
  persistedIdentity: string;
  pendingIdentity: string | null;
}): { accepted: boolean; clearPending: boolean } {
  if (!args.pendingIdentity) {
    return { accepted: true, clearPending: false };
  }
  if (args.persistedIdentity === args.pendingIdentity) {
    return { accepted: true, clearPending: true };
  }
  return { accepted: false, clearPending: false };
}

export function resolveFailedWorkspaceSelectionPersistence(args: {
  attemptedIdentity: string;
  lastPersistedIdentity: string | null;
}): string | null {
  return args.lastPersistedIdentity === args.attemptedIdentity
    ? null
    : args.lastPersistedIdentity;
}
