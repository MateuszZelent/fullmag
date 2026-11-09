import type { CommandContext } from "../commands/commandTypes";

export function studyComputeConfirmationBlockedReason(context: CommandContext): string | null {
  return context.commandFeedback?.hasUnresolvedStudyCompute(context.sessionScopeKey)
    ? "Study submission confirmation is pending. Wait for the existing command before starting another Compute."
    : null;
}
