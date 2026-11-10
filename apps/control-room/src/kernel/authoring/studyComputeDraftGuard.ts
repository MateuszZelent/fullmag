import type { CommandContext } from "../commands/commandTypes";

export function studyComputeDraftBlockedReason(context: CommandContext): string | null {
  const scope = context.sessionScopeKey ?? null;
  const objectEdit = context.objectEditSession;
  if (objectEdit?.hasPendingWrite(scope)) {
    return "Wait for the pending geometry change before starting Compute.";
  }
  if (objectEdit?.hasActiveGesture(scope)) {
    return "Finish the active geometry edit before starting Compute.";
  }
  const draft = objectEdit?.getSnapshot();
  if (draft?.dirty && draft.identity?.sessionScopeKey === scope) {
    return "Apply or discard geometry changes before starting Compute.";
  }

  const forms = context.pendingForms?.getTransitionSnapshot();
  if (forms?.applyingOwnerCount) {
    return "Wait for the Inspector save to finish before starting Compute.";
  }
  if (forms?.guarded || forms?.preparing) {
    return "Wait for the workspace change to finish before starting Compute.";
  }
  if (forms?.dirtyOwnerCount) {
    return "Apply or discard pending Inspector changes before starting Compute.";
  }
  return null;
}
