"use client";

import { useCallback, useMemo, useState } from "react";

import type { RegionalFieldDriveResource } from "@/kernel/api/apiTypes";

import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource, MODEL_FIELD_DRIVES_RESOURCE_KEY } from "@/kernel/resources/fieldDriveResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { milliTeslaToTesla, teslaToMilliTesla, validateFieldDriveDraft } from "@/shared/domain/physics/fieldDrive";
import { buildSincPulsePreview } from "@/shared/domain/physics/sincPulsePreview";
import { Accordion } from "@/shared/ui/Accordion";

import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";
import { regionalFieldDriveSamplingContext, regionalFieldDriveSelectorOptions, resolveRegionalFieldDrivePanelModel } from "./RegionalFieldDrivePanelModel";
import { SincPulsePreview } from "./SincPulsePreview";

export function RegionalFieldDrivePanel({ selection }: InspectorPanelProps) {
  const { api, resources } = useKernel();
  const resource = useFieldDrivesResource();
  const scene = useSceneResource();
  const selectorOptions = useMemo(
    () => regionalFieldDriveSelectorOptions(scene.data ?? null),
    [scene.data],
  );
  const model = useMemo(
    () => resolveRegionalFieldDrivePanelModel(selection, resource.data ?? null),
    [resource.data, selection],
  );
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const drive = model.drive;
  const draftKey = `${drive?.id ?? "none"}:${model.sceneRevision ?? "none"}`;
  const [draftState, setDraftState] = useState<{
    key: string;
    value: RegionalFieldDriveResource | null;
  }>(() => ({ key: draftKey, value: drive ? structuredClone(drive) : null }));
  const draft =
    draftState.key === draftKey
      ? draftState.value
      : drive
        ? structuredClone(drive)
        : null;
  function setDraft(
    update: (
      value: RegionalFieldDriveResource | null,
    ) => RegionalFieldDriveResource | null,
  ): void {
    setDraftState((current) => {
      const currentValue =
        current.key === draftKey
          ? current.value
          : drive
            ? structuredClone(drive)
            : null;
      return { key: draftKey, value: update(currentValue) };
    });
  }
  const selectedStageIds = draft?.activation.kind === "stage_ids" ? draft.activation.stage_ids : [];
  const samplingContext = useMemo(
    () => regionalFieldDriveSamplingContext(scene.data ?? null, draft?.activation ?? null),
    [draft?.activation, scene.data],
  );
  const sincPreview = useMemo(
    () => draft?.waveform.kind === "sinc_pulse"
      ? buildSincPulsePreview({
          cutoffHz: draft.waveform.cutoff_hz,
          t0S: draft.waveform.t0 ?? 0,
          waveformAmplitude: draft.waveform.amplitude ?? 1,
          fieldAmplitudeT: draft.amplitude_B_T,
          samplePeriodS: samplingContext.samplePeriodS,
          durationS: samplingContext.durationS,
        })
      : null,
    [draft, samplingContext.durationS, samplingContext.samplePeriodS],
  );
  const validationErrors = draft ? validateFieldDriveDraft(draft) : [];
  const dirty = Boolean(draft && drive && JSON.stringify(draft) !== JSON.stringify(drive));

  async function save(): Promise<boolean> {
    if (!draft || model.sceneRevision === null) return false;
    if (validationErrors.length > 0) {
      setFeedback(validationErrors.join(" "));
      return false;
    }
    setPending(true);
    setFeedback(null);
    try {
      const response = await api.model.replaceFieldDrive(draft.id, {
        base_revision: model.sceneRevision,
        drive: draft,
      });
      resources.invalidate(MODEL_FIELD_DRIVES_RESOURCE_KEY, response.scene_revision);
      setFeedback("Field drive saved.");
      return true;
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setPending(false);
    }
  }

  const resetInspectorDraft = useCallback(() => {
    setDraftState({
      key: draftKey,
      value: drive ? structuredClone(drive) : null,
    });
    setFeedback(null);
  }, [draftKey, drive]);

  useRegisterInspectorEditSession(
    "staged",
    pending,
    dirty,
    Boolean(draft && model.sceneRevision !== null && validationErrors.length === 0),
    undefined,
    save,
    resetInspectorDraft,
  );

  return (
    <Accordion className="fm-inspector-panel" type="multiple" defaultValue={["drive", "waveform", "activation"]}>
      <InspectorSection value="drive" title="Regional field drive" collapsible defaultCollapsed={false}>
        {model.mode !== "found" ? <FeedbackBanner kind="warning" message="Selected field drive is unavailable." /> : null}
        <FieldRow label="ID" value={model.driveId ?? "none"} />
        <label className="fm-inspector-field"><span>Name</span><input className="fm-inspector-input" disabled={!draft || pending} value={draft?.name ?? ""} onChange={(event) => setDraft((value) => value ? {...value, name:event.target.value} : value)} /></label>
        <label className="fm-inspector-field"><span>Enabled</span><input disabled={!draft || pending} type="checkbox" checked={draft?.enabled ?? false} onChange={(event) => setDraft((value) => value ? {...value, enabled:event.target.checked} : value)} /></label>
        <label className="fm-inspector-field">
          <span>Amplitude (mT)</span>
          <input
            className="fm-inspector-input"
            disabled={!draft || pending}
            min="0"
            step="0.001"
            type="number"
            value={draft ? teslaToMilliTesla(draft.amplitude_B_T) : 0}
            onChange={(event) => setDraft((value) => value ? {...value, amplitude_B_T:milliTeslaToTesla(Number(event.currentTarget.value))} : value)}
          />
        </label>
        <label className="fm-inspector-field"><span>Direction (x, y, z)</span><div className="fm-inspector-vector-row">{[0,1,2].map((index) => <input className="fm-inspector-input" disabled={!draft || pending} key={index} step="0.01" type="number" value={draft?.direction[index] ?? 0} onChange={(event) => setDraft((value) => { if (!value) return value; const direction=[...value.direction]; direction[index]=Number(event.target.value); return {...value,direction}; })} />)}</div></label>
        <label className="fm-inspector-field"><span>Target</span><select className="fm-inspector-input" disabled={!draft || pending} value={draft?.target.kind ?? "global"} onChange={(event) => setDraft((value) => value ? {...value,target:event.target.value === "global" ? {kind:"global"} : event.target.value === "object" ? {kind:"object",object_id:""} : {kind:"region",object_id:"",region_id:""}} : value)}><option value="global">Global</option><option value="object">Object</option><option value="region">Region</option></select></label>
        {draft && draft.target.kind !== "global" ? <label className="fm-inspector-field"><span>Object</span><select className="fm-inspector-input" value={draft.target.object_id} onChange={(event) => setDraft((value) => value && value.target.kind !== "global" ? {...value,target:{...value.target,object_id:event.target.value,...(value.target.kind === "region" ? {region_id:""} : {})}} : value)}><option value="">Select an object</option>{selectorOptions.objects.map((object) => <option key={object.id} value={object.id}>{object.label}</option>)}</select></label> : null}
        {draft?.target.kind === "region" ? <label className="fm-inspector-field"><span>Stable region</span><select className="fm-inspector-input" value={draft.target.region_id} onChange={(event) => setDraft((value) => value?.target.kind === "region" ? {...value,target:{...value.target,region_id:event.target.value}} : value)}><option value="">Select a region</option>{(selectorOptions.regionsByObject[draft.target.object_id] ?? []).map((region) => <option key={region.id} value={region.id}>{region.label}</option>)}</select></label> : null}
        <label className="fm-inspector-field"><span>Spatial profile</span><select className="fm-inspector-input" disabled={!draft || pending} value={draft?.spatial_profile.kind ?? "uniform"} onChange={(event) => setDraft((value) => value ? {...value,spatial_profile:event.target.value === "uniform" ? {kind:"uniform"} : event.target.value === "sinc" ? {kind:"sinc",axis:[1,0,0],period_m:1e-7,center_m:0,window:"none"} : {kind:"geometry_mask",object_id:"",envelope:{kind:"uniform"}}} : value)}><option value="uniform">Uniform</option><option value="sinc">Spatial sinc</option><option value="geometry_mask">Geometry mask</option></select></label>
        {draft?.spatial_profile.kind === "geometry_mask" ? <><label className="fm-inspector-field"><span>Mask geometry</span><select className="fm-inspector-input" value={draft.spatial_profile.object_id} onChange={(event) => setDraft((value) => value?.spatial_profile.kind === "geometry_mask" ? {...value,spatial_profile:{...value.spatial_profile,object_id:event.target.value}} : value)}><option value="">Select an object</option>{selectorOptions.objects.map((object) => <option key={object.id} value={object.id}>{object.label}</option>)}</select></label><label className="fm-inspector-field"><span>Envelope</span><select className="fm-inspector-input" value={draft.spatial_profile.envelope.kind} onChange={(event) => setDraft((value) => value?.spatial_profile.kind === "geometry_mask" ? {...value,spatial_profile:{...value.spatial_profile,envelope:event.target.value === "sinc" ? {kind:"sinc",axis:[1,0,0],period_m:1e-7,center_m:0,window:"none"} : {kind:"uniform"}}} : value)}><option value="uniform">Uniform</option><option value="sinc">Spatial sinc</option></select></label>{draft.spatial_profile.envelope.kind === "sinc" ? <SpatialSincFields profile={draft.spatial_profile.envelope} onChange={(profile) => setDraft((value) => value?.spatial_profile.kind === "geometry_mask" ? {...value,spatial_profile:{...value.spatial_profile,envelope:profile}} : value)} /> : null}</> : null}
        {draft?.spatial_profile.kind === "sinc" ? <SpatialSincFields profile={draft.spatial_profile} onChange={(profile) => setDraft((value) => value ? {...value,spatial_profile:profile} : value)} /> : null}
        {feedback ? <FeedbackBanner kind={feedback === "Field drive saved." ? "success" : "error"} message={feedback} /> : null}
      </InspectorSection>
      <InspectorSection value="waveform" title="Waveform">
        <label className="fm-inspector-field"><span>Kind</span><select className="fm-inspector-input" disabled={!draft || pending} value={draft?.waveform.kind ?? "constant"} onChange={(event) => setDraft((value) => value ? {...value,waveform:event.target.value === "constant" ? {kind:"constant"} : event.target.value === "sinusoidal" ? {kind:"sinusoidal",frequency_hz:1e9,phase_rad:0,offset:0} : event.target.value === "pulse" ? {kind:"pulse",t_on:0,t_off:1e-9} : event.target.value === "piecewise_linear" ? {kind:"piecewise_linear",points:[[0,0],[1e-9,1]]} : {kind:"sinc_pulse",cutoff_hz:20e9,t0:50e-12,amplitude:1}} : value)}><option value="constant">Constant</option><option value="sinusoidal">Sinusoidal</option><option value="pulse">Pulse</option><option value="piecewise_linear">Piecewise linear</option><option value="sinc_pulse">Sinc pulse</option></select></label>
        <label className="fm-inspector-field"><span>Time origin</span><select className="fm-inspector-input" disabled={!draft || pending} value={draft?.time_origin ?? "stage_local"} onChange={(event) => setDraft((value) => value ? {...value,time_origin:event.target.value as "stage_local"|"absolute"} : value)}><option value="stage_local">Stage local</option><option value="absolute">Absolute</option></select></label>
        {draft?.waveform.kind === "sinc_pulse" ? (
          <>
            <FieldRow label="Definition" value="a sinc(2 fc (t - t0))" />
            <label className="fm-inspector-field"><span>Cutoff (Hz)</span><input className="fm-inspector-input" type="number" value={draft.waveform.cutoff_hz} onChange={(event) => setDraft((value) => value?.waveform.kind === "sinc_pulse" ? {...value,waveform:{...value.waveform,cutoff_hz:Number(event.target.value)}} : value)} /></label>
            <label className="fm-inspector-field"><span>Center t0 (s)</span><input className="fm-inspector-input" type="number" value={draft.waveform.t0 ?? 0} onChange={(event) => setDraft((value) => value?.waveform.kind === "sinc_pulse" ? {...value,waveform:{...value.waveform,t0:Number(event.target.value)}} : value)} /></label>
            <label className="fm-inspector-field"><span>Waveform amplitude</span><input className="fm-inspector-input" type="number" value={draft.waveform.amplitude ?? 1} onChange={(event) => setDraft((value) => value?.waveform.kind === "sinc_pulse" ? {...value,waveform:{...value.waveform,amplitude:Number(event.target.value)}} : value)} /></label>
            {sincPreview ? <SincPulsePreview model={sincPreview} solverDtS={samplingContext.solverDtS} /> : null}
          </>
        ) : null}
        {draft?.waveform.kind === "sinusoidal" ? <><label className="fm-inspector-field"><span>Frequency (Hz)</span><input className="fm-inspector-input" type="number" value={draft.waveform.frequency_hz} onChange={(event) => setDraft((value) => value?.waveform.kind === "sinusoidal" ? {...value,waveform:{...value.waveform,frequency_hz:Number(event.target.value)}} : value)} /></label><label className="fm-inspector-field"><span>Phase (rad)</span><input className="fm-inspector-input" type="number" value={draft.waveform.phase_rad ?? 0} onChange={(event) => setDraft((value) => value?.waveform.kind === "sinusoidal" ? {...value,waveform:{...value.waveform,phase_rad:Number(event.target.value)}} : value)} /></label><label className="fm-inspector-field"><span>Offset</span><input className="fm-inspector-input" type="number" value={draft.waveform.offset ?? 0} onChange={(event) => setDraft((value) => value?.waveform.kind === "sinusoidal" ? {...value,waveform:{...value.waveform,offset:Number(event.target.value)}} : value)} /></label></> : null}
        {draft?.waveform.kind === "pulse" ? <><label className="fm-inspector-field"><span>On time (s)</span><input className="fm-inspector-input" type="number" value={draft.waveform.t_on} onChange={(event) => setDraft((value) => value?.waveform.kind === "pulse" ? {...value,waveform:{...value.waveform,t_on:Number(event.target.value)}} : value)} /></label><label className="fm-inspector-field"><span>Off time (s)</span><input className="fm-inspector-input" type="number" value={draft.waveform.t_off} onChange={(event) => setDraft((value) => value?.waveform.kind === "pulse" ? {...value,waveform:{...value.waveform,t_off:Number(event.target.value)}} : value)} /></label></> : null}
        {draft?.waveform.kind === "piecewise_linear" ? <label className="fm-inspector-field"><span>Points (time,value; one pair per line)</span><textarea className="fm-inspector-input" rows={5} value={draft.waveform.points.map((point) => point.join(", ")).join("\n")} onChange={(event) => { const points=event.target.value.split(/\n+/).map((line) => line.split(/[ ,;]+/).filter(Boolean).map(Number)).filter((point) => point.length === 2); setDraft((value) => value?.waveform.kind === "piecewise_linear" ? {...value,waveform:{...value.waveform,points}} : value); }} /></label> : null}
      </InspectorSection>
      <InspectorSection value="activation" title="Stage activation">
        <label className="fm-inspector-field"><span>Mode</span><select className="fm-inspector-input" disabled={!draft || pending} value={draft?.activation.kind ?? "all_time_evolution"} onChange={(event) => setDraft((value) => value ? {...value,activation:event.target.value === "stage_ids" ? {kind:"stage_ids",stage_ids:[]} : {kind:"all_time_evolution"}} : value)}><option value="all_time_evolution">All time stages</option><option value="stage_ids">Selected stages</option></select></label>
        {draft?.activation.kind === "stage_ids" ? <fieldset className="fm-inspector-field"><legend>Run stages</legend>{selectorOptions.timeEvolutionStages.map((stage) => <label key={stage.id}><input type="checkbox" checked={selectedStageIds.includes(stage.id)} onChange={(event) => setDraft((value) => { if (value?.activation.kind !== "stage_ids") return value; const stageIds=event.target.checked ? [...value.activation.stage_ids,stage.id] : value.activation.stage_ids.filter((id) => id !== stage.id); return {...value,activation:{kind:"stage_ids",stage_ids:stageIds}}; })} /> {stage.label}</label>)}{selectorOptions.timeEvolutionStages.length === 0 ? <FeedbackBanner kind="warning" message="No run stage with a stable ID is available. Add a run stage before assigning this drive." /> : null}</fieldset> : <FieldRow label="Stages" value="all time-evolution stages" />}
      </InspectorSection>
    </Accordion>
  );
}

type SpatialSincProfile = Extract<RegionalFieldDriveResource["spatial_profile"], { kind: "sinc" }>;

function SpatialSincFields({ profile, onChange }: { profile: SpatialSincProfile; onChange: (profile: SpatialSincProfile) => void }) {
  return <>
    <label className="fm-inspector-field"><span>Spatial axis (x, y, z)</span><div className="fm-inspector-vector-row">{[0,1,2].map((index) => <input className="fm-inspector-input" key={index} type="number" step="0.01" value={profile.axis[index] ?? 0} onChange={(event) => { const axis=[...profile.axis]; axis[index]=Number(event.target.value); onChange({...profile,axis}); }} />)}</div></label>
    <label className="fm-inspector-field"><span>Spatial period (m)</span><input className="fm-inspector-input" type="number" value={profile.period_m} onChange={(event) => onChange({...profile,period_m:Number(event.target.value)})} /></label>
    <label className="fm-inspector-field"><span>Spatial center (m)</span><input className="fm-inspector-input" type="number" value={profile.center_m ?? 0} onChange={(event) => onChange({...profile,center_m:Number(event.target.value)})} /></label>
    <label className="fm-inspector-field"><span>Spatial width (m, optional)</span><input className="fm-inspector-input" type="number" value={profile.width_m ?? ""} onChange={(event) => onChange({...profile,width_m:event.target.value === "" ? null : Number(event.target.value)})} /></label>
    <label className="fm-inspector-field"><span>Window</span><select className="fm-inspector-input" value={profile.window ?? "none"} onChange={(event) => onChange({...profile,window:event.target.value})}><option value="none">None</option><option value="hann">Hann</option></select></label>
  </>;
}
