export type SolverLifecycle = string;

export type SessionResourceLifecycle = "active" | "tombstoned";
export type SessionConnectivity = "connected" | "degraded" | "disconnected";
export type SessionCommandability = "allowed" | "forbidden" | "read_only";

export interface SessionLifecycleContract {
  solver: SolverLifecycle;
  session_resource: SessionResourceLifecycle;
  connectivity: SessionConnectivity;
  commandability: SessionCommandability;
}

export interface SelectedSessionLifecycle extends SessionLifecycleContract {
  canSubmitCommands: boolean;
  isConnected: boolean;
  isTerminal: boolean;
}

export function selectSessionLifecycle(
  lifecycle: SessionLifecycleContract,
): SelectedSessionLifecycle {
  return {
    ...lifecycle,
    canSubmitCommands:
      lifecycle.commandability === "allowed" &&
      lifecycle.connectivity === "connected" &&
      lifecycle.session_resource === "active",
    isConnected: lifecycle.connectivity === "connected",
    isTerminal: lifecycle.session_resource === "tombstoned",
  };
}
