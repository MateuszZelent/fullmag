"use client";

import { useState } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { useStageExecutionResource } from "@/kernel/resources/studyRuntimeResources";
import { antennaInspectionDisplayMatchesOwner, useAntennaFieldSolutionResource, useAntennaStageOutputCatalogResource, useAntennaExternalLeadInspectionResource, useAntennaInspectionDisplayResource } from "@/kernel/resources/antennaResources";
import { useObjectVisualizationController, useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import { antennaFieldDisplayLabel, type AntennaFieldIntent, type AntennaFieldQuantity } from "@/kernel/visualization/antennaFieldIntent";
import { antennaStageValidationMessages } from "@/shared/domain/physics/antennaStageValidation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { ScientificInspectorContext, ScientificInspectorIdentity } from "../../components/ScientificInspectorTemplate";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { VisualizationDisplayPassesControl, VisualizationRenderModeControl } from "../../visualization/VisualizationInspectorControls";
import { VisualizationInspectorOverview } from "../ObjectVisualizationOverview";
import { AntennaFieldBasisPreview } from "./AntennaFieldBasisPreview";
import { ANTENNA_BASIS_QUANTITIES, type AntennaBasisQuantity } from "./AntennaFieldBasisPreviewModel";
import { antennaFieldSolutionIdentityStatus, resolveAntennaRuntimeIds } from "./AntennaCompositionRuntime";
import { ANTENNA_RAW_QUANTITIES } from "./AntennaVisualizationQuantity";
import { antennaVisualizationPresentation, resolveAntennaVisualizationSelection } from "./AntennaVisualizationModel";
import { inspectionMatchesRuntimeStage, inspectionSelectionMatchesContext, resolveInspectionRuntimeStage, type InspectionRuntimeSelection } from "./AntennaExternalLeadInspectionModel";

type SceneRead = ReturnType<typeof useSceneResource>;

export function AntennaVisualizationPanel(props: InspectorPanelProps) {
  const scene = useSceneResource();
  return <AntennaVisualizationView {...props} scene={scene} />;
}

export function AntennaVisualizationView({ selection, scene }: InspectorPanelProps & { scene: SceneRead }) {
  const visualization = useObjectVisualizationController();
  const objectId = selection.ref?.type === "scene-object" ? selection.ref.objectId : selection.objectId;
  const stages = (scene.data?.antenna_field_solve_stages ?? []).filter((stage) => stage.source_object_id === objectId);
  const [preferredStage, setPreferredStage] = useState("");
  const stage = stages.find((candidate) => candidate.id === preferredStage) ?? stages[0];
  return <div className="fm-inspector-panel fm-scientific-inspector" data-inspector-owner="object.antenna.visualization">
    <ScientificInspectorIdentity title="Antenna visualization" physicalLabel="Conductor / Oersted field" methodLabel="Display controls" />
    <AntennaPublishedVisualization objectId={objectId} stageId={stage?.id ?? null} scene={scene.data} sceneStatus={scene.status} />
    <InspectorGroup title="Source" collapsible defaultOpen={false}>
      <FieldRow label="Source object" value={objectId ?? "none"} mono />
      {stages.length ? <Select value={stage?.id} onValueChange={(value) => { setPreferredStage(value); visualization.setAntennaFieldIntent(null); }}>
        <SelectTrigger aria-label="Antenna visualization solve"><SelectValue /></SelectTrigger>
        <SelectContent>{stages.map((item) => <SelectItem key={item.id} value={item.id}>{item.id}</SelectItem>)}</SelectContent>
      </Select> : <p role="status">No antenna field-solve stage is configured. Configure and execute a standalone antenna solve before inspecting numerical results; LLG is not required.</p>}
      <p>Source FFT belongs to Antenna → Spectrum; it is not a magnetization response.</p>
    </InspectorGroup>
  </div>;
}

function AntennaPublishedVisualization({ objectId, stageId, scene, sceneStatus }: { objectId: string | null; stageId: string | null; scene: SceneResource | null; sceneStatus: string }) {
  const ids = resolveAntennaRuntimeIds("solution", stageId, scene);
  const field = useAntennaFieldSolutionResource(ids.solutionId);
  const catalog = useAntennaStageOutputCatalogResource(ids.stageId);
  const owner = useSessionResourceIdentity();
  const execution = useStageExecutionResource();
  const [inspectionSelection, setInspectionSelection] = useState<InspectionRuntimeSelection | null>(null);
  if (inspectionSelection && !inspectionSelectionMatchesContext(inspectionSelection, stageId ?? "", execution.data, owner)) {
    setInspectionSelection(null);
  }
  const mapping = resolveInspectionRuntimeStage(stageId ?? "", execution.data, owner, inspectionSelection);
  const executionCurrent = execution.status === "ready" && !execution.refreshError;
  const inspection = useAntennaExternalLeadInspectionResource(mapping.state === "mapped" ? mapping.runtimeStageId : null, { pauseLoad: !executionCurrent });
  const visualization = useObjectVisualizationController();
  const requested = useObjectVisualizationSelector((snapshot) => snapshot.antennaFieldIntent ?? null);
  const displayStatus = useObjectVisualizationSelector((snapshot) => snapshot.antennaFieldDisplayStatus ?? null);
  const [quantity, setQuantity] = useState<AntennaFieldQuantity>("magnetic_field_per_ampere");
  const [preferredPort, setPreferredPort] = useState("");
  const [displaySource, setDisplaySource] = useState("basis");
  const stage = scene?.antenna_field_solve_stages?.find((candidate) => candidate.id === stageId);
  const validation = stage ? antennaStageValidationMessages(stage, scene) : ["Missing solve stage"];
  const identity = antennaFieldSolutionIdentityStatus(ids, field, catalog);
  const sourceMatches = field.data?.source_object_id === objectId && field.data?.current_transport_id === stage?.current_transport_id;
  const ownerMatches = owner && field.data?.session_id === owner.sessionId && field.data?.session_epoch === owner.sessionEpoch && field.data?.request_scope_epoch === owner.requestScopeEpoch;
  const basisAvailable = sceneStatus === "ready" && validation.length === 0 && identity === "ready" && sourceMatches && ownerMatches;
  const raw = inspection.data;
  const rawOwnerMatches = sceneStatus === "ready" && executionCurrent && inspection.status === "ready" && !inspection.refreshError && raw?.status === "inspection_only" &&
    raw.qualification === "NOT VERIFIED" && raw.field_scope === "external_electrode_truncation" && raw.manifest?.source_object_id === objectId &&
    inspectionMatchesRuntimeStage(raw, stageId ?? "", mapping, owner) && raw.outputs.length === 1 && raw.outputs[0].inspection_ref.content_digest === raw.manifest.content_digest;
  const rawDisplay = useAntennaInspectionDisplayResource(rawOwnerMatches ? raw : null);
  const rawAvailable = Boolean(rawOwnerMatches && raw && rawDisplay.status === "ready" && !rawDisplay.refreshError && rawDisplay.data && antennaInspectionDisplayMatchesOwner(raw, rawDisplay.data));
  const { inspectionMode, available, ports, port, currentAvailable, effectiveQuantity, current, surfaceAvailable, active } =
    resolveAntennaVisualizationSelection({ objectId, stageId, owner, basisAvailable, rawAvailable, rawOwnerMatches,
      raw, field: field.data, display: rawDisplay.data, requested, quantity, preferredPort, displaySource });
  const setDisplay = (patch: Partial<AntennaFieldIntent>) => {
    const selectedPort = patch.portModeId ?? port;
    if (!available || !owner || !objectId || !stageId || !selectedPort || !ports.includes(selectedPort)) return;
    const data = inspectionMode ? raw : field.data;
    if (!data) return;
    visualization.setAntennaFieldIntent({
      kind: inspectionMode ? "inspection" : "basis", sessionId: owner.sessionId, sessionEpoch: owner.sessionEpoch, requestScopeEpoch: owner.requestScopeEpoch,
      sourceObjectId: objectId, stageId, solutionId: inspectionMode ? raw?.output_id ?? "" : field.data?.solution_id ?? "",
      runtimeStageId: inspectionMode ? raw?.runtime_stage_id : undefined, runId: inspectionMode ? raw?.run_id : undefined,
      contentDigest: inspectionMode ? raw?.manifest?.content_digest ?? "" : field.data?.content_digest ?? "",
      recordContentDigest: inspectionMode ? raw?.record_content_digest : undefined, stageRevision: inspectionMode ? raw?.stage_revision : undefined,
      portModeId: selectedPort, quantity: effectiveQuantity, points: active?.points ?? false,
      surface: surfaceAvailable && (active?.surface ?? false), wireframe: surfaceAvailable && (active?.wireframe ?? false),
      vectors: effectiveQuantity === "electric_potential_per_ampere" || effectiveQuantity === "device_potential" ? false : active?.vectors ?? false,
      component: active?.component ?? "magnitude", palette: active?.palette ?? "viridis", ...patch,
    });
  };
  const unavailableReason = rawDisplay.error?.message ?? (!stageId ? "No configured antenna solve stage" : validation.join("; ") || (identity === "ready" && !sourceMatches ? "source/transport mismatch" : identity === "ready" && !ownerMatches ? "session owner mismatch" : sceneStatus !== "ready" ? `scene ${sceneStatus}` : identity));
  const { quantitySpec, carrierLabel, renderReason, rangeHint } =
    antennaVisualizationPresentation({ objectId, effectiveQuantity, inspectionMode, surfaceAvailable, current, raw, field: field.data });
  return <>
    <VisualizationInspectorOverview
      dataState={available ? "Published snapshot" : "Unavailable"}
      meshState={surfaceAvailable ? "Retained device Tet4 topology" : "Published sample positions; no surface binding"}
      quantitySource={antennaFieldDisplayLabel({ quantity: effectiveQuantity })}
      enabledPassCount={Number(active?.points ?? false) + Number(active?.vectors ?? false) + Number(active?.surface ?? false) + Number(active?.wireframe ?? false)}
      display={<>
        <Select value={mapping.state === "mapped" ? mapping.runtimeStageId : ""} disabled={!executionCurrent || mapping.candidates.length === 0} onValueChange={(runtimeStageId) => {
          if (owner && stageId && execution.data && mapping.candidates.some((candidate) => candidate.runtimeStageId === runtimeStageId)) {
            setInspectionSelection({ authoredStageId: stageId, runtimeStageId, runId: execution.data.run_id, identity: owner });
            visualization.setAntennaFieldIntent(null);
          }
        }}>
          <SelectTrigger aria-label="Antenna visualization execution"><SelectValue placeholder="Select an inspection execution" /></SelectTrigger>
          <SelectContent>{mapping.candidates.map((candidate) => <SelectItem key={candidate.runtimeStageId} value={candidate.runtimeStageId}>{candidate.runtimeStageId} · {candidate.status}</SelectItem>)}</SelectContent>
        </Select>
        {mapping.state !== "mapped" ? <p role="status">{mapping.message}</p> : null}
        <VisualizationDisplayPassesControl items={[
          { id: "surface", label: "Surface", pressed: active?.surface ?? false, disabled: !surfaceAvailable || !port, onToggle: () => setDisplay({ surface: !active?.surface }) },
          { id: "wireframe", label: "Wireframe", pressed: active?.wireframe ?? false, disabled: !surfaceAvailable || !port, onToggle: () => setDisplay({ wireframe: !active?.wireframe }) },
          { id: "points", label: "Points", pressed: active?.points ?? false, disabled: !available || !port, onToggle: () => setDisplay({ points: !active?.points }) },
          { id: "vectors", label: "Vectors", pressed: active?.vectors ?? false, disabled: !available || !port || quantitySpec.components === 1, onToggle: () => setDisplay({ vectors: !active?.vectors }) },
        ]} />
        <VisualizationRenderModeControl disabled={!available || !port} options={surfaceAvailable ? ["surface", "surface+edges", "wireframe", "points", "off"] : ["points", "off"]} value={active?.surface ? active.wireframe ? "surface+edges" : "surface" : active?.wireframe ? "wireframe" : active?.points ? "points" : "off"} onValueChange={(value) => setDisplay({ surface: value === "surface" || value === "surface+edges", wireframe: value === "wireframe" || value === "surface+edges", points: value === "points", vectors: value === "off" ? false : active?.vectors ?? false })} />
        <FieldRow label="Quantity" value={quantitySpec.label} />
        <Select disabled={!available} value={effectiveQuantity} onValueChange={(value) => { setQuantity(value as AntennaFieldQuantity); setDisplay({ quantity: value as AntennaFieldQuantity, surface: false, wireframe: false, vectors: value === "electric_potential_per_ampere" || value === "device_potential" ? false : active?.vectors ?? false }); }}>
          <SelectTrigger aria-label="Antenna quantity"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(inspectionMode ? ANTENNA_RAW_QUANTITIES : ANTENNA_BASIS_QUANTITIES).filter(([id]) => id !== "current_density" || currentAvailable).map(([id, spec]) => <SelectItem key={id} value={id}>{spec.label} [{spec.unit}]</SelectItem>)}</SelectContent>
        </Select>
        <FormField label="Snapshot" type="select" value={inspectionMode ? "inspection" : "basis"} onChange={(event) => { setQuantity(effectiveQuantity); setDisplaySource(event.target.value); visualization.setAntennaFieldIntent(null); }}><option value="basis" disabled={!basisAvailable}>Published per-ampere basis</option><option value="inspection" disabled={!rawAvailable}>Inspection only · raw current · NOT VERIFIED</option></FormField>
        <FormField label="Port mode" type="select" disabled={!available} value={port} onChange={(event) => { setPreferredPort(event.target.value); setDisplay({ portModeId: event.target.value }); }}><option value="" disabled>Select a published port</option>{ports.map((id) => <option key={id} value={id}>{id}</option>)}</FormField>
        <p role="status">{available ? inspectionMode ? `Raw authored-current ${antennaFieldDisplayLabel({ quantity: effectiveQuantity })}, inspection only · NOT VERIFIED; not a reusable basis, source FFT or LLG drive.` : "Per-ampere published snapshot; waveform scaling is not applied." : unavailableReason}</p>
        <FormField label="Carrier" type="select" disabled value="published" hint="The selected quantity owns its published carrier. No resampling onto the primitive preview is performed."><option value="published">{carrierLabel}</option></FormField>
        <FormField label="Component" type="select" disabled={!available || !port || quantitySpec.components === 1} value={quantitySpec.components === 1 ? "scalar" : active?.component ?? "magnitude"} onChange={(event) => setDisplay({ component: event.target.value as AntennaFieldIntent["component"] })} hint="Color projection only; glyph direction remains the full Cartesian vector."><option value="scalar" disabled>Scalar</option><option value="magnitude">Magnitude</option><option value="x">x</option><option value="y">y</option><option value="z">z</option></FormField>
        <p role="status">{renderReason}</p>
        {active && displayStatus?.intentKey === JSON.stringify(active) ? <>
          <FieldRow label="Field display" value={`${displayStatus.status}: ${displayStatus.reason}`} />
          {displayStatus.status === "ready" ? <><FieldRow label="Rendered samples" value={String(displayStatus.sampleCount)} /><FieldRow label="Full color range" value={`${displayStatus.minimum?.toExponential(4)} … ${displayStatus.maximum?.toExponential(4)}`} unit={quantitySpec.unit} /></> : null}
        </> : null}
      </>}
      surfaceColoring={<InspectorGroup title="Surface Coloring" badge={surfaceAvailable ? "device Tet4" : "unavailable"}>
        <FormField label="Color source" type="select" disabled value="basis" hint={renderReason}><option value="basis">{quantitySpec.label}</option></FormField>
        <FormField label="Color range" type="select" disabled value={surfaceAvailable ? "auto" : "unavailable"} hint={rangeHint}><option value="unavailable">No surface binding</option><option value="auto">{current ? "Global sampled J range" : "Full finite nodal range"}</option></FormField>
        <FormField label="Point / vector palette" type="select" disabled={!available || !port} value={active?.palette ?? "viridis"} onChange={(event) => setDisplay({ palette: event.target.value as AntennaFieldIntent["palette"] })} hint={current ? rangeHint : "Auto range over all complete, finite field samples; no primitive surface colors."}><option value="viridis">Viridis</option><option value="coolwarm">Coolwarm</option></FormField>
      </InspectorGroup>}
      vectors={<InspectorGroup title="Vectors" badge={quantitySpec.components === 1 ? "scalar" : "published carrier"}>
        <FormField label="Show vectors" type="checkbox" disabled={!available || !port || quantitySpec.components === 1} checked={active?.vectors ?? false} onChange={(event) => setDisplay({ vectors: event.target.checked })} hint={quantitySpec.components === 1 ? "Electric potential is scalar; vector glyphs do not apply." : "Full Cartesian glyphs, one global amplitude-preserving display scale derived from carrier bounds, independent of camera."} />
        <FormField label="Vector component" type="select" disabled value={quantitySpec.components === 1 ? "none" : "xyz"}><option value="none">Not applicable (scalar)</option><option value="xyz">Cartesian vector</option></FormField>
      </InspectorGroup>}
      clipping={<p>Field clipping requires a compatible spatial field carrier. It is unavailable for this numerical preview.</p>}
      camera={<p>Camera and conductor geometry display belong to the workspace viewport. This numerical preview does not change either.</p>}
      advanced={<p>{renderReason}</p>}
    />
    <ScientificInspectorContext
      collapsible defaultOpen={false}
      status={{ resource: available ? inspectionMode ? "inspection only · NOT VERIFIED" : "published snapshot" : "unavailable", execution: "No solve triggered by visualization", availability: available ? surfaceAvailable ? current ? "Actual device Tet4 surface / boundary wireframe / cell-center points and vectors" : "Actual device Tet4 surface / boundary wireframe / nodal points" : "Actual sample points / vector glyphs; no surface" : unavailableReason }}
      properties={[{ label: "Source object", value: objectId ?? "none", mono: true }, { label: "Field unit", value: quantitySpec.unit }, { label: "Scaling", value: inspectionMode ? "Raw authored current. Inspection-only, NOT VERIFIED, external electrode truncation; not reusable per-ampere basis or LLG drive." : "Per 1 A, before waveform scaling or LLG; not instantaneous V_electric, J_charge or H_ant." }]}
      provenance={available && inspectionMode && raw ? [{ label: "Record digest", value: raw.record_content_digest, mono: true }, { label: "Field digest", value: raw.manifest?.content_digest ?? "none", mono: true }] : available && field.data ? [{ label: "Asset", value: field.data.asset_id, mono: true }, { label: "Geometry pin", value: field.data.geometry_revision, mono: true }, { label: "Material pin", value: field.data.material_revision, mono: true }, { label: "Mesh pin", value: field.data.mesh_digest, mono: true }] : []}
      diagnostics={[available ? "Verified publication identity; current-input equivalence is not certified by this view." : unavailableReason, "Immutable published snapshot. Geometry/material edits require a new solve or runtime-validated reuse. No field is painted onto an unrelated primitive mesh.", ...(field.error || catalog.error ? [field.error?.message ?? catalog.error?.message ?? "Resource error"] : [])]}
    />
    {basisAvailable && !inspectionMode && !active?.points && !active?.vectors && field.data ? <AntennaFieldBasisPreview key={`${field.data.asset_id}:${effectiveQuantity}`} solution={field.data} quantity={effectiveQuantity as AntennaBasisQuantity} /> : null}
  </>;
}
