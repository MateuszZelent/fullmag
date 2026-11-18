import { MODEL_READINESS_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { ControlRoomApi } from "@/kernel/api/ControlRoomApi";
import type { AuthoringTransactionResponse, RequestOptions, RuntimeCommandPrecondition } from "@/kernel/api/apiTypes";
import type { CommandResult } from "@/kernel/commands/commandTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import type { AuthoredStageCommandInput, StageInitialStateChoice } from "@/kernel/runtime/studyStageInitialState";

import { changedStudyComputeInput } from "@/kernel/runtime/studyComputeInput";

export type StageApplyRunPin = RuntimeCommandPrecondition & { scene_revision: number };

interface ExecuteStageAfterApplyOptions {
  api: Pick<ControlRoomApi, "model" | "sessions">;
  apply(): Promise<AuthoringTransactionResponse | null>;
  execute(
    input: AuthoredStageCommandInput,
    resources: Readonly<Record<string, unknown>>,
  ): Promise<CommandResult>;
  initialState?: StageInitialStateChoice;
  isCurrent(): boolean;
  pin: StageApplyRunPin;
  requestOptions?: RequestOptions;
  stageId: string;
}

export async function executeStageAfterApply({
  api, apply, execute, initialState, isCurrent, pin, requestOptions, stageId,
}: ExecuteStageAfterApplyOptions): Promise<CommandResult> {
  const cancelled = (): CommandResult => ({
    message: "The selected stage or workspace changed before Compute.",
    status: "cancelled",
  });
  if (!isCurrent()) return cancelled();
  const source = initialState ?? { kind: "default_for_target" as const };

  const receipt = await apply();
  if (!isCurrent()) return cancelled();
  if (!receipt || receipt.scene_revision < pin.scene_revision ||
      receipt.committed_scene?.revision !== receipt.scene_revision) {
    return { message: "The stage save was not confirmed. Review the draft before running.", status: "failed" };
  }

  try {
    const [status, readiness] = await Promise.all([
      api.sessions.current.status(requestOptions),
      api.model.readiness(requestOptions),
    ]);
    if (!isCurrent()) return cancelled();
    if (status.resources.scene_revision !== receipt.scene_revision ||
        readiness.scene_revision !== receipt.scene_revision) {
      return { message: "The stage was saved, but the current scene differs from the save confirmation.", status: "failed" };
    }
    const changed = changedStudyComputeInput({ ...pin, scene_revision: receipt.scene_revision }, status);
    if (changed) {
      return { message: `The stage was saved, but the ${changed} changed before Compute.`, status: "failed" };
    }
    if (!readiness.ready_to_run) {
      return {
        message: readiness.blockers[0] ?? "The stage was saved. Complete the model checklist before running.",
        status: "failed",
      };
    }
    return await execute({ stageId, initialState: source }, {
      [MODEL_SCENE_PATH]: receipt.committed_scene,
      [MODEL_READINESS_PATH]: readiness,
      [SESSION_STATUS_RESOURCE_KEY]: status,
    });
  } catch (error) {
    if (!isCurrent()) return cancelled();
    const detail = error instanceof Error ? ` ${error.message}` : "";
    return { message: `The stage was saved, but Compute could not be started.${detail}`, status: "failed" };
  }
}
