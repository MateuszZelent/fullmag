"use client";

import { useId, useMemo } from "react";
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";
import type { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useStageExecutionResource } from "@/kernel/resources/studyRuntimeResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { artifactInspectionAvailability } from "@/kernel/visualization/artifactInspectionAvailability";
import { artifactInspectionOwnerPlan } from "@/kernel/visualization/artifactFieldSelection";
import { useObjectVisualizationController, useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";
import { FieldRow } from "../primitives/FieldRow";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { InspectorPropertyRow } from "../primitives/InspectorPropertyRow";

export function useArtifactInspectionSource(scene: ReturnType<typeof useSceneResource>, sourceObjectId: string | null = null) {
  const visualization = useObjectVisualizationController();
  const session = useSessionResourceIdentity();
  const execution = useStageExecutionResource();
  const pin = useObjectVisualizationSelector(snapshot => snapshot.artifactFieldSelection ?? null);
  const plan = useMemo(() => artifactInspectionOwnerPlan(scene.data?.antenna_field_solve_stages ?? [],
    execution.status === "ready" && !execution.refreshError ? execution.data : null, session, pin),
  [scene.data, execution.status, execution.refreshError, execution.data, session, pin]);
  const candidates = plan.candidates.filter(candidate => sourceObjectId === null || candidate.sourceObjectId === sourceObjectId);
  const selected = plan.selected && (sourceObjectId === null || plan.selected.sourceObjectId === sourceObjectId) ? plan.selected : null;
  const error = execution.error?.message ?? execution.refreshError?.message ?? plan.error;
  const sourceNames = new Map((scene.data?.objects ?? []).map(object => [object.id, object.name || object.id]));
  const inspection = artifactInspectionAvailability(selected, execution.data);
  return { visualization, execution, pin, candidates, selected, error, sourceNames, inspection, retainedOwner: inspection.owner };
}

export function artifactInspectionSourceGuidance({ loading, error, candidateCount, selectedStatus, inspectionState }: {
  loading: boolean;
  error: string | null;
  candidateCount: number;
  selectedStatus: string | null;
  inspectionState?: "retained" | "absent" | "unknown";
}): string {
  if (error) return "Execution information is unavailable. Check the diagnostic below or open Results for a saved run.";
  if (loading) return "Loading executions. Existing display settings remain unchanged.";
  if (candidateCount === 0) return "No execution is retained in this session. Open Results and choose Saved to inspect an existing field. A solve definition or visible mesh alone does not contain field values.";
  if (!selectedStatus) return "Select the antenna execution whose field you want to inspect. This does not start a simulation.";
  if (inspectionState === "absent") return "This execution has no retained field in the current session. Open Results → Saved to choose a stored result. No new computation is needed to inspect a saved field.";
  if (inspectionState === "unknown") return "Retained field availability is not confirmed. Field requests are paused; refresh the execution information or open Results → Saved.";
  if (selectedStatus === "failed" || selectedStatus === "cancelled") return "This execution did not complete successfully. Check its diagnostic or choose another result; completion and field availability are checked separately.";
  if (selectedStatus === "completed" || selectedStatus === "succeeded") return "Execution completed. Choose an available Quantity source below, then enable Vectors to inspect a vector field. Only verified field data on a compatible sampling mesh can be displayed.";
  return "The selected execution has not completed. Field values appear only after they are published; mesh visibility does not indicate a computed field.";
}

export function ArtifactInspectionSource({ source, universe = false }: {
  source: ReturnType<typeof useArtifactInspectionSource>;
  universe?: boolean;
}) {
  const { layout } = useKernel();
  const { visualization, execution, pin, candidates, selected, error, sourceNames } = source;
  const loading = execution.status === "idle" || execution.status === "loading";
  const guidanceId = useId();
  const selectedExecution = selected ? candidates.find(candidate => candidate.runtimeStageId === selected.runtimeStageId) : null;
  const failureReason = selectedExecution?.status === "failed"
    ? execution.data?.stages.find(stage => stage.stage_id === selectedExecution.runtimeStageId)?.state_transition_reason
    : null;
  const catalogError = execution.error?.message ?? execution.refreshError?.message ?? (candidates.length === 0 ? error : null);
  const guidance = artifactInspectionSourceGuidance({ loading, error: catalogError, candidateCount: candidates.length, selectedStatus: selectedExecution?.status ?? null, inspectionState: selected ? source.inspection.state : undefined });
  return <InspectorGroup title={universe ? "Antenna field result" : "Field result"} collapsible defaultOpen>
    <FieldRow label="Physical source" value={selected ? sourceNames.get(selected.sourceObjectId) ?? selected.sourceObjectId : "Select a source and execution"} />
    <FieldRow label="Sampling mesh" value={universe ? "Saved sampling mesh of the selected result; domain must be verified" : "Saved conductor or sampling mesh of the selected result"} />
    <FieldRow label="Execution status" value={selectedExecution?.status ?? "No execution selected"} />
    <FieldRow label="Retained field" value={!selected ? "No execution selected" : source.inspection.state === "retained" ? "Registered · payload verification required" : source.inspection.state === "absent" ? "Not retained in this session" : "Availability not confirmed"} />
    <InspectorPropertyRow label="Execution" layout="stacked">
    <Select value={selected?.runtimeStageId ?? ""} disabled={execution.status !== "ready" || Boolean(execution.refreshError) || candidates.length === 0} onValueChange={runtimeStageId => {
      const candidate = candidates.find(item => item.runtimeStageId === runtimeStageId);
      if (!candidate) return;
      const { status: _status, ...owner } = candidate;
      visualization.setAntennaFieldIntent(null);
      visualization.setArtifactFieldSelection(owner);
    }}>
      <SelectTrigger className="w-full min-w-0" aria-describedby={guidanceId} aria-label={universe ? "Universe inspection execution" : "Antenna inspection execution"}><SelectValue placeholder={loading ? "Loading executions…" : catalogError ? "Execution catalog unavailable" : candidates.length === 0 ? "No execution available" : "Select an execution explicitly"} /></SelectTrigger>
      <SelectContent className="fm-inspector-select-content">{candidates.map(candidate => <SelectItem key={candidate.runtimeStageId} value={candidate.runtimeStageId}>{sourceNames.get(candidate.sourceObjectId) ?? candidate.sourceObjectId} · {candidate.authoredStageId} · {candidate.status}</SelectItem>)}</SelectContent>
    </Select>
    </InspectorPropertyRow>
    <p id={guidanceId} className="fm-inspection-source-guidance" role="status">{guidance}</p>
    {selected ? <InspectorGroup title="Result identity" collapsible defaultOpen={false}><FieldRow label="Source ID" value={selected.sourceObjectId} mono /><FieldRow label="Run ID" value={selected.runId} mono /><FieldRow label="Authored solve" value={selected.authoredStageId} mono /><FieldRow label="Runtime stage" value={selected.runtimeStageId} mono /><FieldRow label="Carrier scope" value={pin?.carrierScopeKind ? `${pin.carrierScopeKind}: ${pin.carrierScopeId ?? "full"}` : "Awaiting immutable carrier metadata"} mono /></InspectorGroup> : null}
    <Button size="sm" variant="secondary" onClick={() => layout.openSavedResults()}>Browse saved results</Button>
    {universe ? <p role="status">Oersted H (A/m) uses the selected result’s saved sampling domain. Opening Universe does not establish full-volume coverage. Current density J belongs to the conductors. The saved mesh may differ from the current editable Universe.</p> : null}
    {failureReason ? <FeedbackBanner kind="error" message={failureReason} /> : null}
    {error ? <FeedbackBanner kind="warning" message={error} /> : null}
  </InspectorGroup>;
}
