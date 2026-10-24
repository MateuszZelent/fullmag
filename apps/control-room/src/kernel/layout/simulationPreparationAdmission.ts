import type { ComputeNodesResource } from "../api/apiTypes";
import type { SimulationPreparationViewModel } from "./simulationPreparationModel";

export const CPU_QUOTA_ADMISSION_BLOCKER =
  "Native preparation cannot be admitted: this host reports no worker CPU quota " +
  "enforcement, so the scheduler keeps the task queued. This happens after a backend " +
  "restart without its launcher; restart it through the launcher (Docker DEV: " +
  "`just docker-dev`) to delegate the worker cgroup.";

/** Whether the startup is waiting on a scheduler admission rather than on work. */
export function preparationAwaitsAdmission(
  state: Pick<SimulationPreparationViewModel, "activeStage" | "isTerminal" | "isVisible">,
): boolean {
  return (
    state.isVisible &&
    !state.isTerminal &&
    state.activeStage?.id === "domain_preparation"
  );
}

/**
 * The ledger refuses every quota-requiring admission while CPU quota
 * enforcement is unavailable, and the refusal is silent: the task stays
 * queued. Name that cause instead of showing an indefinite wait.
 */
export function preparationAdmissionBlocker(
  computeNodes: ComputeNodesResource | null,
): string | null {
  const blocked = computeNodes?.nodes.some((node) => {
    const enforcement = node.snapshot?.enforcement;
    return (
      typeof enforcement === "object" &&
      enforcement !== null &&
      (enforcement as Record<string, unknown>).cpu_quota === "unavailable"
    );
  });
  return blocked ? CPU_QUOTA_ADMISSION_BLOCKER : null;
}
