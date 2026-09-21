import type { KernelEventMap } from "@/kernel/events/eventTypes";

export interface MeshBuildDialogState {
  request: KernelEventMap["mesh:build-confirm-requested"] | null;
  acceptedCommandId: string | null;
  errorMessage: string | null;
  lastCommandStatus: string;
  open: boolean;
  phase: "pre-build" | "submitting" | "waiting" | "post-build" | "error";
  publishedRevision: number | null;
  renderedRevision: number | null;
}

export const initialMeshBuildDialogState: MeshBuildDialogState = {
  request: null,
  acceptedCommandId: null,
  errorMessage: null,
  lastCommandStatus: "pending-confirmation",
  open: false,
  phase: "pre-build",
  publishedRevision: null,
  renderedRevision: null,
};

export type MeshBuildDialogAction =
  | { type: "request"; request: KernelEventMap["mesh:build-confirm-requested"] }
  | { type: "restore"; event: KernelEventMap["mesh:build-observation-requested"] }
  | { type: "accepted"; event: KernelEventMap["mesh:build-submitted"] }
  | { type: "observed"; event: KernelEventMap["mesh:build-observed"] }
  | { type: "rendered"; revision: number | string }
  | { type: "submitting" }
  | { type: "open"; open: boolean };

export function meshBuildDialogReducer(
  state: MeshBuildDialogState,
  action: MeshBuildDialogAction,
): MeshBuildDialogState {
  switch (action.type) {
    case "request":
      return { ...initialMeshBuildDialogState, request: action.request, open: true };
    case "restore":
      return { ...initialMeshBuildDialogState, open: true, phase: "submitting",
        acceptedCommandId: action.event.commandId, lastCommandStatus: "observing",
        request: { commandId: action.event.targetKind === "object_mesh" ? "mesh.build-selected" : "mesh.build-shared-domain",
          requestId: action.event.requestId, source: "inspector",
          input: { mesh_target: { kind: action.event.targetKind, object_id: action.event.objectId } } } };
    case "open":
      return { ...state, open: action.open };
    case "submitting":
      if (state.phase !== "pre-build" && state.phase !== "waiting") return state;
      return { ...state, phase: "submitting", lastCommandStatus: "submitting" };
    case "accepted":
      if (!state.request?.requestId || action.event.requestId !== state.request.requestId
        || (state.phase !== "submitting" && state.phase !== "waiting")) return state;
      return { ...state, acceptedCommandId: action.event.commandId,
        lastCommandStatus: "accepted", phase: "submitting" };
    case "observed": {
      const event = action.event;
      if (!state.request?.requestId || event.requestId !== state.request.requestId
        || (state.acceptedCommandId && event.commandId !== state.acceptedCommandId)
        || state.phase === "error" || state.phase === "post-build"
        || state.phase === "pre-build") return state;
      if (event.status === "failed" || event.status === "cancelled") {
        return { ...state, phase: "error", lastCommandStatus: event.status,
          errorMessage: event.message ?? "Mesh command did not complete." };
      }
      if (event.status === "pending" || event.meshRevision === undefined) {
        return { ...state, phase: "waiting", lastCommandStatus: event.observation ?? "waiting",
          errorMessage: event.message ?? "The build is still being observed. No failure has been reported." };
      }
      return { ...state, phase: "post-build", publishedRevision: event.meshRevision,
        lastCommandStatus: state.renderedRevision === event.meshRevision ? "rendered" : "published",
        errorMessage: null };
    }
    case "rendered": {
      const revision = Number(action.revision);
      if (!Number.isFinite(revision) || state.phase === "error" || state.phase === "pre-build") return state;
      // Rendering alone never completes a command. It may precede its terminal HTTP observation.
      return { ...state, renderedRevision: revision,
        lastCommandStatus: state.phase === "post-build" && state.publishedRevision === revision
          ? "rendered" : state.lastCommandStatus };
    }
  }
}