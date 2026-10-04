import type { ControlRoomApi } from "../api/ControlRoomApi";
import type { PendingFormRegistry } from "../authoring/PendingFormRegistry";

type SessionCreationApi = Pick<ControlRoomApi["sessions"], "create">;
type CreateProblemRequest = Parameters<SessionCreationApi["create"]>[0];
type CreateProblemResponse = Awaited<ReturnType<SessionCreationApi["create"]>>;

export interface AcceptedProblemCreation {
  response: CreateProblemResponse;
  draftsPreserved: boolean;
  finalizationError: string | null;
}

/** The modal caller keeps the old workspace inaccessible until this settles. */
export async function createProblemWithPendingFormGuard(
  sessions: SessionCreationApi,
  pendingForms: PendingFormRegistry | undefined,
  request: CreateProblemRequest,
  clearHistory: () => void = () => undefined,
): Promise<AcceptedProblemCreation> {
  if (!pendingForms) {
    throw new Error("Inspector draft validation is unavailable. Keep the current workspace open.");
  }
  const guard = await pendingForms.prepareTransition({ applyPendingChanges: false });
  let accepted: AcceptedProblemCreation | null = null;
  try {
    guard.assertCurrent();
    const response = await sessions.create(request);
    accepted = { response, draftsPreserved: true, finalizationError: null };
    try {
      guard.assertCurrent();
      // No await or subscriber callback precedes the registry's Map.clear.
      // A listener registering a new form after clear cannot lose that form.
      pendingForms.clear();
      accepted.draftsPreserved = false;
      clearHistory();
    } catch (error) {
      accepted.finalizationError = error instanceof Error ? error.message : String(error);
    }
    return accepted;
  } finally {
    try {
      guard.release();
    } catch (error) {
      // A cleanup listener must not turn an acknowledged create into an
      // apparent failed request that the caller might submit again.
      if (accepted) {
        accepted.finalizationError = error instanceof Error ? error.message : String(error);
      }
    }
  }
}
