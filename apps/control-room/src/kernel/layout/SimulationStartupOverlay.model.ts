import type { ResourceResult } from "../resources/resourceTypes";
import type { LiveStatusResource } from "../api/apiTypes";
import { resolveSimulationPreparationViewModel, type SimulationPreparationViewModel } from "./simulationPreparationModel";
import type { KernelApi } from "../types";

export type SimulationStartupOverlayState = SimulationPreparationViewModel & {
  /** Why a queued preparation cannot be admitted, when the host reports it. */
  readonly admissionBlocker?: string | null;
};

export interface SimulationStartupOverlayOptions {
  readonly allowMissingSessionSmoke?: boolean;
}

interface SimulationStartupOverlayResourceState {
  readonly refetch: () => void;
  readonly state: SimulationStartupOverlayState;
  readonly status: ResourceResult<LiveStatusResource>;
}

const EMPTY_PREPARATION_RESOURCE = {
  data: null,
  error: null,
  refetch: () => undefined,
  revision: null,
  status: "idle",
} satisfies ResourceResult<never>;

export function resolveSimulationStartupOverlayState(
  status: ResourceResult<LiveStatusResource>,
  options: SimulationStartupOverlayOptions = {},
): SimulationStartupOverlayState {
  const state = resolveSimulationPreparationViewModel(
    EMPTY_PREPARATION_RESOURCE,
    status,
    null,
  );
  return options.allowMissingSessionSmoke ? hideStartupOverlay(state) : state;
}

export function hideStartupOverlay(
  state: SimulationStartupOverlayState,
): SimulationStartupOverlayState {
  return {
    ...state,
    isVisible: false,
    kind: "hidden",
  };
}

type SimulationPreparationDiagnosticsNavigation = {
  readonly bus: {
    emit: (
      event: "footer:tab-requested",
      payload: { reason?: string; tab: "diagnostics" },
    ) => void;
  };
  readonly layout: Pick<KernelApi["layout"], "openBottomPanel">;
};

export function openSimulationPreparationDiagnostics(
  kernel: SimulationPreparationDiagnosticsNavigation,
): void {
  kernel.layout.openBottomPanel("diagnostics");
  kernel.bus.emit("footer:tab-requested", {
    reason: "simulation-preparation",
    tab: "diagnostics",
  });
}

export function shouldRefreshSimulationStartupStatus(
  state: SimulationStartupOverlayState,
): boolean {
  return state.isVisible && (state.kind === "stale" || !state.isTerminal);
}

export function selectSimulationStartupOverlayResourceState(
  status: ResourceResult<LiveStatusResource>,
): SimulationStartupOverlayResourceState {
  return {
    refetch: status.refetch,
    state: resolveSimulationStartupOverlayState(status),
    status,
  };
}

export function simulationStartupOverlayResourceStateEquals(
  previous: SimulationStartupOverlayResourceState,
  next: SimulationStartupOverlayResourceState,
): boolean {
  return (
    Object.is(previous.refetch, next.refetch) &&
    previous.status.status === next.status.status &&
    previous.status.error === next.status.error &&
    previous.status.revision === next.status.revision &&
    previous.status.data?.session.session_id ===
      next.status.data?.session.session_id &&
    previous.status.data?.session.session_epoch ===
      next.status.data?.session.session_epoch &&
    previous.status.data?.session.request_scope_epoch ===
      next.status.data?.session.request_scope_epoch &&
    previous.status.data?.lifecycle.session_resource ===
      next.status.data?.lifecycle.session_resource &&
    previous.status.data?.lifecycle.solver ===
      next.status.data?.lifecycle.solver &&
    previous.status.data?.solver.state === next.status.data?.solver.state &&
    previous.status.data?.run?.run_id === next.status.data?.run?.run_id &&
    previous.status.data?.domain.discretization ===
      next.status.data?.domain.discretization &&
    previous.status.data?.domain.generation_id ===
      next.status.data?.domain.generation_id &&
    previous.status.data?.domain.cell_count ===
      next.status.data?.domain.cell_count &&
    previous.status.data?.resources.domain_generation_id ===
      next.status.data?.resources.domain_generation_id &&
    previous.status.data?.resources.mesh_revision ===
      next.status.data?.resources.mesh_revision &&
    previous.status.data?.resources.simulation_preparation_revision ===
      next.status.data?.resources.simulation_preparation_revision
  );
}
