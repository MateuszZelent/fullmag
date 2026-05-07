import type { Dispatch, SetStateAction } from "react";
import type { ControlRoomApi } from "@/components/runs/control-room/controlRoomApi";
import type { SceneDocument } from "@/lib/session/types";
import { getLiveSessionClient } from "@/src/api/client/LiveSessionClient";

type AppendFrontendTrace = (level: string, message: string) => void;

interface EnqueueRuntimeCommandParams {
  appendFrontendTrace: AppendFrontendTrace;
  liveApi: ControlRoomApi;
  payload: Record<string, unknown>;
  setCommandErrorMessage: Dispatch<SetStateAction<string | null>>;
  setCommandPostInFlight: Dispatch<SetStateAction<boolean>>;
}

interface BuilderAutoSyncHandle {
  cancelPendingPush: () => void;
  recordPushSignature: (signature: string | null) => void;
}

interface SyncScriptBuilderCommandParams {
  appendFrontendTrace: AppendFrontendTrace;
  builderAutoSync: BuilderAutoSyncHandle;
  liveApi: ControlRoomApi;
  localBuilderDraft: SceneDocument | null;
  localBuilderSignature: string;
  scriptPath: string | null;
  setScriptSyncBusy: Dispatch<SetStateAction<boolean>>;
  setScriptSyncMessage: Dispatch<SetStateAction<string | null>>;
}

export async function enqueueRuntimeCommand({
  appendFrontendTrace,
  liveApi,
  payload,
  setCommandErrorMessage,
  setCommandPostInFlight,
}: EnqueueRuntimeCommandParams): Promise<void> {
  setCommandPostInFlight(true);
  setCommandErrorMessage(null);
  const commandKind =
    typeof payload.kind === "string" ? payload.kind.toUpperCase() : "COMMAND";
  appendFrontendTrace("info", `TX: ${commandKind} ${JSON.stringify(payload)}`);
  try {
    if (payload.kind === "solve") {
      const realization = await getLiveSessionClient().scene.createGeometryRealization({});
      if (realization.status === "blocked") {
        const reason =
          realization.diagnostics.find((diagnostic) =>
            diagnostic.blocks.includes("run_solver"),
          )?.message ?? "Geometry realization is blocked.";
        throw new Error(reason);
      }
      appendFrontendTrace(
        "system",
        `RX: geometry realization ${realization.status} scene_rev=${realization.source_scene_revision}`,
      );
    }
    await liveApi.queueCommand(payload);
    appendFrontendTrace("system", `RX: HTTP accepted ${commandKind}`);
  } catch (error) {
    appendFrontendTrace(
      "warn",
      `RX: HTTP rejected ${commandKind} — ${error instanceof Error ? error.message : "Failed to queue command"}`,
    );
    setCommandErrorMessage(error instanceof Error ? error.message : "Failed to queue command");
  } finally {
    setCommandPostInFlight(false);
  }
}

export function handleComputeCommand(
  enqueueCommand: (payload: Record<string, unknown>) => Promise<void>,
): void {
  void enqueueCommand({ kind: "solve" });
}

export async function syncScriptBuilderCommand({
  appendFrontendTrace,
  builderAutoSync,
  liveApi,
  localBuilderDraft,
  localBuilderSignature,
  scriptPath,
  setScriptSyncBusy,
  setScriptSyncMessage,
}: SyncScriptBuilderCommandParams): Promise<void> {
  if (!scriptPath) {
    setScriptSyncMessage("No script path is available for the active workspace");
    appendFrontendTrace("warn", "TX: SCRIPT_SYNC skipped — no script path available");
    return;
  }

  setScriptSyncBusy(true);
  setScriptSyncMessage(null);
  appendFrontendTrace("info", `TX: SCRIPT_SYNC ${scriptPath}`);
  try {
    if (!localBuilderDraft) {
      throw new Error("No scene document is available for script sync");
    }
    builderAutoSync.cancelPendingPush();
    await liveApi.updateSceneDocument(localBuilderDraft);
    builderAutoSync.recordPushSignature(localBuilderSignature);
    const response = await liveApi.syncScript();
    const syncedPath =
      typeof response.script_path === "string" && response.script_path.trim().length > 0
        ? response.script_path
        : scriptPath;
    setScriptSyncMessage(`Synced ${syncedPath.split("/").pop() ?? "script"} to canonical Python`);
    appendFrontendTrace(
      "success",
      `RX: SCRIPT_SYNC ok — ${syncedPath.split("/").pop() ?? "script"}`,
    );
  } catch (error) {
    setScriptSyncMessage(error instanceof Error ? error.message : "Failed to sync script");
    appendFrontendTrace(
      "error",
      `RX: SCRIPT_SYNC failed — ${error instanceof Error ? error.message : "Failed to sync script"}`,
    );
  } finally {
    setScriptSyncBusy(false);
  }
}
