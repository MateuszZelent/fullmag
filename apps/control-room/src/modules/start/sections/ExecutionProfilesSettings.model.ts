import type { ExecutionProfile } from "@/kernel/api/apiTypes";
import { executionAvailabilityFor, type ExecutionAvailability } from "../model/executionAvailability";
import { newProfileDraft, type ExecutionProfileDraft } from "../model/executionProfileDraft";

export function newExecutionProfileDraft(
  source: ExecutionProfile | undefined,
  executionAvailability?: ExecutionAvailability,
): ExecutionProfileDraft {
  const nextDraft = newProfileDraft(source);
  if (!source) {
    const availability = executionAvailabilityFor(
      executionAvailability,
      nextDraft.profile.defaults.backend,
    );
    if (!availability.gpu.enabled && availability.cpu.enabled) {
      nextDraft.profile = {
        ...nextDraft.profile,
        defaults: { ...nextDraft.profile.defaults, device: "cpu" },
      };
    }
  }
  return nextDraft;
}
