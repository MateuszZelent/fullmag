"use client";

import { useMemo } from "react";
import { useStageExecutionResource } from "@/kernel/resources/studyRuntimeResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { artifactInspectionOwnerPlan } from "@/kernel/visualization/artifactFieldSelection";
import { useObjectVisualizationController, useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import type { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { VisualizationTargetInspectorPanel, type VisualizationInspectorOwner } from "../ObjectVisualizationPanel";

const OWNER: VisualizationInspectorOwner = {
  id: "object.antenna.visualization",
  title: "Antenna visualization",
  targetLabel: "Historical conductor / sampling carrier",
  capabilityDescription: "Raw H, current density J and electric potential V on their immutable result carriers.",
  actionSummary: "Inspect a source and execution; adjust common display passes without recomputing fields.",
};

type Props = InspectorPanelProps & { scene: ReturnType<typeof useSceneResource> };

export function AntennaArtifactVisualization({ selection, scene }: Props) {
  const source = useAntennaInspectionSource({ selection, scene });
  return <VisualizationTargetInspectorPanel owner={OWNER} selection={selection} sceneOverride={scene} artifactInspection artifactInspectionOwner={source.selected}>
    <AntennaInspectionSource source={source} />
  </VisualizationTargetInspectorPanel>;
}

function useAntennaInspectionSource({ selection, scene }: Props) {
  const objectId = selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const visualization = useObjectVisualizationController();
  const session = useSessionResourceIdentity();
  const execution = useStageExecutionResource();
  const pin = useObjectVisualizationSelector(snapshot => snapshot.artifactFieldSelection ?? null);
  const plan = useMemo(() => artifactInspectionOwnerPlan(scene.data?.antenna_field_solve_stages ?? [],
    execution.status === "ready" && !execution.refreshError ? execution.data : null, session, pin),
  [scene.data, execution.status, execution.refreshError, execution.data, session, pin]);
  const candidates = plan.candidates.filter(candidate => candidate.sourceObjectId === objectId);
  const selected = plan.selected?.sourceObjectId === objectId ? plan.selected : null;
  const error = execution.error?.message ?? execution.refreshError?.message ?? plan.error;
  return { objectId, visualization, execution, pin, candidates, selected, error };
}

function AntennaInspectionSource({ source }: { source: ReturnType<typeof useAntennaInspectionSource> }) {
  const { objectId, visualization, execution, pin, candidates, selected, error } = source;
  return <InspectorGroup title="Source and execution" collapsible defaultOpen>
    <FieldRow label="Source object" value={objectId ?? "none"} mono />
    <FieldRow label="Result state" value="Historical inspection; raw SI values; read-only" />
    <Select value={selected?.runtimeStageId ?? ""} disabled={execution.status !== "ready" || Boolean(execution.refreshError) || candidates.length === 0} onValueChange={runtimeStageId => {
      const candidate = candidates.find(item => item.runtimeStageId === runtimeStageId);
      if (!candidate) return;
      const { status: _status, ...owner } = candidate;
      visualization.setAntennaFieldIntent(null);
      visualization.setArtifactFieldSelection(owner);
    }}>
      <SelectTrigger aria-label="Antenna inspection execution"><SelectValue placeholder="Select an execution explicitly" /></SelectTrigger>
      <SelectContent>{candidates.map(candidate => <SelectItem key={candidate.runtimeStageId} value={candidate.runtimeStageId}>{candidate.authoredStageId} · {candidate.runtimeStageId} · {candidate.status}</SelectItem>)}</SelectContent>
    </Select>
    {selected ? <><FieldRow label="Run ID" value={selected.runId} mono /><FieldRow label="Authored solve" value={selected.authoredStageId} mono /><FieldRow label="Runtime stage" value={selected.runtimeStageId} mono /><FieldRow label="Carrier scope" value={pin?.carrierScopeKind ? `${pin.carrierScopeKind}: ${pin.carrierScopeId ?? "full"}` : "Awaiting immutable carrier metadata"} mono /></> : null}
    {error ? <FeedbackBanner kind="warning" message={error} /> : candidates.length === 0 ? <p role="status">No retained execution is available for this source. A solve definition alone is not a numerical result.</p> : null}
  </InspectorGroup>;
}
