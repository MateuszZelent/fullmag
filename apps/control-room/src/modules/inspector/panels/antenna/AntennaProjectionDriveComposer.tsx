import { useState } from "react";

import { MODEL_READINESS_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { composeAntennaProjectionDrive } from "./AntennaProjectionDriveComposerModel";
import { antennaRunStageIds } from "./SolvedAntennaDriveEditorModel";

interface Props {
  stageId: string;
  scene: SceneResource | null;
  status: string;
  refetch: () => void;
}

export function AntennaProjectionDriveComposer({ stageId, scene, status, refetch }: Props) {
  const { api, resources } = useKernel();
  const [targetId, setTargetId] = useState("");
  const [runId, setRunId] = useState("");
  const [peakCurrent, setPeakCurrent] = useState("");
  const [frequency, setFrequency] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [awaitingRevision, setAwaitingRevision] = useState<number | null>(null);
  const stage = scene?.antenna_field_solve_stages?.find((item) => item.id === stageId);
  if (!stage) return null;
  const targets = scene?.objects?.filter((object) => object.id !== stage.source_object_id) ?? [];
  const runs = antennaRunStageIds(scene);
  const revision = scene?.revision;
  const canCreate = status === "ready" && typeof revision === "number" &&
    Number.isSafeInteger(revision) && revision >= 0 && !pending &&
    revision !== conflictRevision && (awaitingRevision === null || revision >= awaitingRevision);

  async function create() {
    if (!scene || !canCreate || typeof revision !== "number") return;
    try {
      const { projection, drive } = composeAntennaProjectionDrive(
        scene, stageId, targetId, runId, peakCurrent, frequency,
      );
      setPending(true);
      setFeedback(null);
      const response = await api.model.commitTransaction({
        base_revision: revision,
        kind: "merge_patch",
        merge_patch: {
          antenna_target_projections: [
            ...(scene.antenna_target_projections ?? []) as unknown as JsonObject[], projection,
          ],
          solved_antenna_drives: [
            ...(scene.solved_antenna_drives ?? []) as unknown as JsonObject[], drive,
          ],
        },
      });
      resources.invalidate(MODEL_SCENE_PATH, response.scene_revision);
      resources.invalidate(MODEL_READINESS_PATH, response.scene_revision);
      setAwaitingRevision(response.scene_revision);
      setFeedback({ kind: "success", message: `Projection ${projection.id} and drive ${drive.id} committed. Run the field-solve stage before LLG.` });
    } catch (error) {
      const isConflict = (error as { status?: number })?.status === 409;
      if (isConflict) setConflictRevision(revision);
      const message = isConflict
        ? "Scene revision conflict. Refresh the scene and review the composition before retrying."
        : error instanceof Error ? error.message : String(error);
      setFeedback({ kind: "error", message });
    } finally {
      setPending(false);
    }
  }

  return <InspectorGroup title="Compose projection and drive">
    <FormField label="Target object" type="select" value={targetId} onChange={(event) => setTargetId(event.currentTarget.value)}>
      <option value="">Select target object</option>
      {targets.map((object) => <option key={object.id} value={object.id}>{object.name || object.id} ({object.id})</option>)}
    </FormField>
    <FormField label="Run stage" type="select" value={runId} onChange={(event) => setRunId(event.currentTarget.value)}>
      <option value="">Select Run stage</option>
      {runs.map((id) => <option key={id} value={id}>{id}</option>)}
    </FormField>
    <FormField label="Peak current" unit="A" value={peakCurrent} onChange={(event) => setPeakCurrent(event.currentTarget.value)} />
    <FormField label="Frequency" unit="Hz" value={frequency} onChange={(event) => setFrequency(event.currentTarget.value)} />
    {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    {conflictRevision === revision ? <Button type="button" disabled={pending} onClick={refetch}>Refetch Scene</Button> : null}
    <Button type="button" disabled={!canCreate} onClick={() => void create()}>Create projection and drive</Button>
  </InspectorGroup>;
}
