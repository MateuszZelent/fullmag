import { useEffect } from "react";
import type { MutableRefObject } from "react";
import type {
  WorkspaceSelectionReplaceRequest,
  WorkspaceSelectionResource,
} from "@/src/api/types";
import {
  resolveFailedWorkspaceSelectionPersistence,
  resolvePersistedWorkspaceSelection,
  workspaceSelectionIdentity,
} from "../workspaceSelectionGuards";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { writeFrontendDiagnosticConsole } from "@/lib/debug/frontendConsoleDebug";

const ENABLE_WORKSPACE_SELECTION_DEBUG_LOGS =
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production" &&
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace;

export function useWorkspaceSelectionPersistence({
  lastPersistedWorkspaceSelectionRef,
  pendingWorkspaceSelectionIdentityRef,
  replaceWorkspaceSelection,
  sceneResourceSessionKey,
  selectedEntityId,
  selectedObjectId,
  selectedSidebarNodeId,
  workspaceSelectionHydratingRef,
  workspaceSelectionLoading,
}: {
  lastPersistedWorkspaceSelectionRef: MutableRefObject<string | null>;
  pendingWorkspaceSelectionIdentityRef: MutableRefObject<string | null>;
  replaceWorkspaceSelection: (
    request: WorkspaceSelectionReplaceRequest,
  ) => Promise<WorkspaceSelectionResource | null>;
  sceneResourceSessionKey: string | null;
  selectedEntityId: string | null;
  selectedObjectId: string | null;
  selectedSidebarNodeId: string | null;
  workspaceSelectionHydratingRef: MutableRefObject<boolean>;
  workspaceSelectionLoading: boolean;
}) {
  useEffect(() => {
    if (!sceneResourceSessionKey || workspaceSelectionLoading || workspaceSelectionHydratingRef.current) {
      return;
    }
    const nextIdentity = workspaceSelectionIdentity({
      selected_node_id: selectedSidebarNodeId,
      selected_object_id: selectedObjectId,
      selected_entity_id: selectedEntityId,
    });
    if (lastPersistedWorkspaceSelectionRef.current === nextIdentity) {
      return;
    }
    lastPersistedWorkspaceSelectionRef.current = nextIdentity;
    pendingWorkspaceSelectionIdentityRef.current = nextIdentity;
    void replaceWorkspaceSelection({
      selected_node_id: selectedSidebarNodeId,
      selected_object_id: selectedObjectId,
      selected_entity_id: selectedEntityId,
    }).then((persisted) => {
      if (persisted) {
        const persistedIdentity = workspaceSelectionIdentity(persisted);
        const decision = resolvePersistedWorkspaceSelection({
          persistedIdentity,
          pendingIdentity: pendingWorkspaceSelectionIdentityRef.current,
        });
        if (decision.accepted) {
          lastPersistedWorkspaceSelectionRef.current = persistedIdentity;
          if (decision.clearPending) {
            pendingWorkspaceSelectionIdentityRef.current = null;
          }
          return;
        }
        if (ENABLE_WORKSPACE_SELECTION_DEBUG_LOGS) {
          writeFrontendDiagnosticConsole("debug", "[ControlRoomContext] Ignoring stale workspace selection persistence response", {
            pendingIdentity: pendingWorkspaceSelectionIdentityRef.current,
            persistedIdentity,
          });
        }
        return;
      }
      if (lastPersistedWorkspaceSelectionRef.current === nextIdentity) {
        lastPersistedWorkspaceSelectionRef.current = resolveFailedWorkspaceSelectionPersistence({
          attemptedIdentity: nextIdentity,
          lastPersistedIdentity: lastPersistedWorkspaceSelectionRef.current,
        });
      }
    });
  }, [
    lastPersistedWorkspaceSelectionRef,
    pendingWorkspaceSelectionIdentityRef,
    replaceWorkspaceSelection,
    sceneResourceSessionKey,
    selectedEntityId,
    selectedObjectId,
    selectedSidebarNodeId,
    workspaceSelectionHydratingRef,
    workspaceSelectionLoading,
  ]);
}
