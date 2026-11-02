import type { SceneResource } from "@/kernel/api/apiTypes";
import { readStudyStageSource } from "@/shared/domain/study/studyStageSource";

export function readAuthoredAntennaStages(scene: SceneResource | null) {
  const source = readStudyStageSource(scene?.study);
  const stages = source.entries
    .filter((entry) => (entry.stageKind ?? entry.payload.kind) === "antenna_field_solve")
    .map((entry) => {
      const id = typeof entry.payload.stage_id === "string" ? entry.payload.stage_id : null;
      const definitions = scene?.antenna_field_solve_stages?.filter((stage) => stage.id === id) ?? [];
      const definition = definitions.length === 1 ? definitions[0] : null;
      return { id, label: entry.label, queueId: entry.queueId, enabled: entry.enabled, definition };
    });
  return { stages, error: source.error };
}

export function AuthoredAntennaTelemetry({
  scene,
  sceneStatus,
  hasRun,
}: {
  scene: SceneResource | null;
  sceneStatus: string;
  hasRun: boolean | null;
}) {
  const { stages, error } = readAuthoredAntennaStages(scene);
  const enabled = stages.some((stage) => stage.enabled);
  let title: string;
  let description: string;
  if (!scene) {
    title = sceneStatus === "error" ? "Antenna study could not be loaded" : "Loading antenna study";
    description = "The authored study must be available before its antenna stages can be shown.";
  } else if (error) {
    title = "Antenna study needs attention";
    description = error;
  } else if (!stages.length) {
    title = "No antenna stage scheduled";
    description = "Add an antenna field solve stage to the executable study. An antenna object alone does not schedule a solve.";
  } else if (!enabled) {
    title = "Antenna stages disabled";
    description = "Enable an antenna stage and its parent groups before computing the study.";
  } else if (hasRun === null) {
    title = "Antenna execution state unavailable";
    description = "The authored stages are listed below. Waiting for the current session status before reporting whether execution has started.";
  } else if (hasRun) {
    title = "Antenna execution progress unavailable";
    description = "The authored stages are listed below. No matching antenna execution record is published for the current session and run.";
  } else {
    title = "Antenna stage configured — not started";
    description = "Compute starts study validation and preparation. Progress and estimated time appear when the solver publishes its workload.";
  }
  return (
    <div className="fm-footer-telemetry__empty" role="region" aria-label="Antenna telemetry">
      <strong>{title}</strong>
      <span>{description}</span>
      {stages.map((stage, index) => (
        <span key={stage.queueId ?? stage.id ?? index}>
          {stage.label ?? stage.id ?? "Antenna stage"}
          {stage.label && stage.id ? ` (${stage.id})` : ""}
          {stage.enabled ? " · Enabled" : " · Disabled"}
          {stage.definition ? ` · Source: ${stage.definition.source_object_id} · Transport: ${stage.definition.current_transport_id}` : " · Definition unavailable"}
        </span>
      ))}
    </div>
  );
}
