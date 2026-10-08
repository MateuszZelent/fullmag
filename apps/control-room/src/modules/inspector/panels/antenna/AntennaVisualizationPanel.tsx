"use client";

import { useState } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useAntennaFieldSolutionResource, useAntennaStageOutputCatalogResource } from "@/kernel/resources/antennaResources";
import { antennaStageValidationMessages } from "@/shared/domain/physics/antennaStageValidation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { AntennaFieldBasisPreview } from "./AntennaFieldBasisPreview";
import { ANTENNA_BASIS_QUANTITIES, type AntennaBasisQuantity } from "./AntennaFieldBasisPreviewModel";
import { antennaFieldSolutionIdentityStatus, resolveAntennaRuntimeIds } from "./AntennaCompositionRuntime";

type SceneRead = ReturnType<typeof useSceneResource>;

export function isAntennaVisualizationObject(scene: SceneResource | null, objectId: string | null): boolean {
  const object = scene?.objects?.find((candidate) => candidate.id === objectId);
  if (!object) return false;
  const hint = (object as Record<string, unknown>).visualization_hint as { role?: unknown } | null | undefined;
  if (object.role && object.role !== "magnet") return object.role === "antenna";
  return hint?.role === "antenna" || object.tags?.includes("role:antenna") === true;
}

export function AntennaVisualizationPanel(props: InspectorPanelProps) {
  const scene = useSceneResource();
  return <AntennaVisualizationView {...props} scene={scene} />;
}

export function AntennaVisualizationView({ selection, scene }: InspectorPanelProps & { scene: SceneRead }) {
  const objectId = selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const stages = (scene.data?.antenna_field_solve_stages ?? []).filter((stage) => stage.source_object_id === objectId);
  const [preferredStage, setPreferredStage] = useState("");
  const stage = stages.find((candidate) => candidate.id === preferredStage) ?? stages[0];
  return <div className="fm-inspector-panel" data-inspector-owner="object.antenna.visualization">
    <InspectorGroup title="Antenna visualization" description="Conductor and direct Oersted-field results, separate from magnetization and magnetic-object display controls.">
      <FieldRow label="Source object" value={objectId ?? "none"} mono />
      <FieldRow label="Conductor quantities" value="Electric potential V/I; current density J/I" />
      <FieldRow label="Field quantity" value="Direct Oersted field H/I on the published sampling domain" />
      <p>These are port bases normalized per ampere, not instantaneous V, J or H. H_ant after current/waveform scaling belongs to the receiving object or airbox. Source FFT is inspected under Antenna → Spectrum, not as magnetization response.</p>
      {stages.length ? <Select value={stage?.id} onValueChange={setPreferredStage}>
        <SelectTrigger aria-label="Antenna visualization solve"><SelectValue /></SelectTrigger>
        <SelectContent>{stages.map((item) => <SelectItem key={item.id} value={item.id}>{item.id}</SelectItem>)}</SelectContent>
      </Select> : <p role="status">No antenna field-solve stage is configured. Configure and execute a standalone antenna solve before inspecting numerical results; LLG is not required.</p>}
    </InspectorGroup>
    {stage && scene.data ? <AntennaPublishedVisualization key={`${objectId}:${stage.id}`} objectId={objectId} stageId={stage.id} scene={scene.data} sceneStatus={scene.status} /> : null}
  </div>;
}

function AntennaPublishedVisualization({ objectId, stageId, scene, sceneStatus }: { objectId: string | null; stageId: string; scene: SceneResource; sceneStatus: string }) {
  const ids = resolveAntennaRuntimeIds("solution", stageId, scene);
  const field = useAntennaFieldSolutionResource(ids.solutionId);
  const catalog = useAntennaStageOutputCatalogResource(ids.stageId);
  const owner = useSessionResourceIdentity();
  const [quantity, setQuantity] = useState<AntennaBasisQuantity>("magnetic_field_per_ampere");
  const stage = scene.antenna_field_solve_stages?.find((candidate) => candidate.id === stageId);
  const validation = stage ? antennaStageValidationMessages(stage, scene) : ["Missing solve stage"];
  const identity = antennaFieldSolutionIdentityStatus(ids, field, catalog);
  const sourceMatches = field.data?.source_object_id === objectId && field.data?.current_transport_id === stage?.current_transport_id;
  const ownerMatches = owner && field.data?.session_id === owner.sessionId && field.data?.session_epoch === owner.sessionEpoch && field.data?.request_scope_epoch === owner.requestScopeEpoch;
  const available = sceneStatus === "ready" && validation.length === 0 && identity === "ready" && sourceMatches && ownerMatches;
  return <>
    <InspectorGroup title="Published antenna result" badge={available ? "published snapshot" : "unavailable"}>
      <p role="status">{available ? "Verified publication identity; current-input equivalence is not certified by this view." : validation.join("; ") || (identity === "ready" && !sourceMatches ? "source/transport mismatch" : identity === "ready" && !ownerMatches ? "session owner mismatch" : sceneStatus !== "ready" ? `scene ${sceneStatus}` : identity)}</p>
      {available && field.data ? <>
        <FieldRow label="Asset" value={field.data.asset_id} mono />
        <FieldRow label="Geometry pin" value={field.data.geometry_revision} mono />
        <FieldRow label="Material pin" value={field.data.material_revision} mono />
        <FieldRow label="Mesh pin" value={field.data.mesh_digest} mono />
        <p>Immutable published snapshot. Geometry/material edits require a new solve or runtime-validated reuse. No field is painted onto an unrelated primitive mesh.</p>
        <Select value={quantity} onValueChange={(value) => setQuantity(value as AntennaBasisQuantity)}>
          <SelectTrigger aria-label="Antenna quantity"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(ANTENNA_BASIS_QUANTITIES).map(([id, spec]) => <SelectItem key={id} value={id}>{spec.label} [{spec.unit}]</SelectItem>)}</SelectContent>
        </Select>
      </> : <p role="status">No compatible published antenna result is available. Magnetic quantities and magnetic airbox controls are not antenna results.</p>}
      {field.error || catalog.error ? <p role="alert">{field.error?.message ?? catalog.error?.message}</p> : null}
    </InspectorGroup>
    {available && field.data ? <AntennaFieldBasisPreview key={`${field.data.asset_id}:${quantity}`} solution={field.data} quantity={quantity} /> : null}
  </>;
}
