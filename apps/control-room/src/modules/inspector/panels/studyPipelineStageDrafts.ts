import type { JsonObject } from "@/kernel/api/apiTypes";
import type { StudyStageSourceEntry } from "@/shared/domain/study/studyStageSource";

import {
  createStudyStageDraft,
  type StudyStageDraft,
  type StudyStageDraftKind,
} from "./StudyStageAuthoringModel";

/** Canonical primitive `stage_kind` values that have a typed stage draft. */
const PIPELINE_PRIMITIVE_DRAFT_KINDS: Readonly<Record<string, StudyStageDraftKind>> = {
  add_field_drive: "add_field_drive",
  antenna_field_solve: "antenna_field_solve",
  autosave: "autosave",
  change_device: "change_device",
  eigenmodes: "eigenmodes",
  fft_response: "fft_response",
  frequency_response: "frequency_response",
  hysteresis: "hysteresis",
  relax: "relax",
  run: "run",
  save_state: "save_state",
  table_autosave: "table_autosave",
};

/**
 * Build inspector drafts for canonical `study_pipeline` entries.
 *
 * Known primitive payloads are parsed into typed drafts so the inspector shows
 * their configuration; `pipelineNodeId` keeps them read-only. Macros and other
 * primitives stay `unsupported`, with the original payload preserved.
 */
export function createPipelineStudyStageDrafts(
  entries: readonly StudyStageSourceEntry[],
): StudyStageDraft[] {
  return entries.map((entry, index) => {
    const draftKind = entry.stageKind
      ? PIPELINE_PRIMITIVE_DRAFT_KINDS[entry.stageKind]
      : undefined;
    const parsed = draftKind
      ? createStudyStageDraft({ ...entry.payload, kind: draftKind }, index)
      : null;
    const draft = parsed && parsed.kind === draftKind
      ? parsed
      : createStudyStageDraft({ kind: "unsupported" }, index);
    return {
      ...draft,
      rawStage: structuredClone(entry.payload) as JsonObject,
      stageId: entry.queueId ?? `stage-${index + 1}`,
      pipelineNodeId: entry.queueId ?? undefined,
      pipelineEnabled: entry.enabled,
      pipelineGroupIds: [...entry.groupIds],
    };
  });
}
