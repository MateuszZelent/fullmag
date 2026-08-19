"use client";

import { useState } from "react";

import type {
  ModeCompositionController,
  ModeCompositionLayer,
  ModeCompositionResource,
  ModeFieldComponent,
  ModeFieldRepresentation,
} from "@/kernel/visualization/ModeCompositionController";
import { Button } from "@/shared/ui/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { Slider } from "@/shared/ui/Slider";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import type {
  ModeCompositionCompatibleObject,
  ModeCompositionInspectorDependencies,
  ModeCompositionInspectorSpectrum,
  ModeCompositionSpectrumMode,
  ModeCompositionSpectrumSample,
} from "./modeCompositionInspectorTypes";
export type {
  ModeCompositionCompatibleObject,
  ModeCompositionInspectorDependencies,
  ModeCompositionInspectorSpectrum,
  ModeCompositionSpectrumMode,
  ModeCompositionSpectrumSample,
} from "./modeCompositionInspectorTypes";

type InspectorDependenciesProps = InspectorPanelProps & {
  readonly dependencies?: ModeCompositionInspectorDependencies;
};

type SpectrumComponent = "total" | "x" | "y" | "z";
type SpectrumScope = "global" | `object:${string}`;

const SIGNED_REPRESENTATIONS = new Set<ModeFieldRepresentation>([
  "phase_rotated_real",
  "real",
  "imag",
]);

export function legalModeLayerComponents(
  representation: ModeFieldRepresentation,
): readonly ModeFieldComponent[] {
  if (representation === "phase") return ["x", "y", "z"];
  if (representation === "abs") return ["x", "y", "z", "magnitude"];
  return ["x", "y", "z", "magnitude", "vector"];
}

export function eigenModeLayerAppearanceDefaults(
  representation: ModeFieldRepresentation,
): ModeCompositionLayer["appearance"] {
  if (representation === "phase") {
    return {
      auto_range: false,
      colorbar_visible: true,
      colormap: "twilight",
      opacity: 1,
      range_max: Math.PI,
      range_min: -Math.PI,
      symmetric_zero: false,
      vector_budget: 512,
      vector_length_scale: 1,
      vectors_visible: false,
    };
  }
  if (representation === "abs") {
    return {
      auto_range: true,
      colorbar_visible: true,
      colormap: "viridis",
      opacity: 1,
      symmetric_zero: false,
      vector_budget: 512,
      vector_length_scale: 1,
      vectors_visible: false,
    };
  }
  return {
    auto_range: true,
    colorbar_visible: true,
    colormap: "coolwarm",
    opacity: 1,
    symmetric_zero: true,
    vector_budget: 512,
    vector_length_scale: 1,
    vectors_visible: false,
  };
}

export function EigenSpectrumCompositionInspectorPanel({
  dependencies,
  selection,
}: InspectorDependenciesProps) {
  const samples = dependencies?.spectrum?.samples ?? [];
  const [sampleId, setSampleId] = useState(samples[0]?.sampleId ?? "");
  const [scope, setScope] = useState<SpectrumScope>("global");
  const [component, setComponent] = useState<SpectrumComponent>("total");
  const [selectedModeId, setSelectedModeId] = useState<string | null>(null);
  const sample = samples.find((candidate) => candidate.sampleId === sampleId) ?? samples[0];
  const selectedMode = sample?.modes.find((mode) => mode.modeId === selectedModeId) ?? null;

  if (!dependencies?.spectrum) {
    return <ModeCompositionUnavailable selection={selection} surface="eigen-spectrum" />;
  }

  return (
    <div className="fm-mode-composition-inspector" data-inspector-surface="eigen-spectrum-v3">
      <InspectorGroup title="Eigen Spectrum" badge="Participation">
        <div className="fm-mode-composition-inspector__controls">
          <label className="fm-mode-composition-inspector__control">
            <span>Sample</span>
            <Select value={sample?.sampleId ?? ""} onValueChange={setSampleId}>
              <SelectTrigger aria-label="Spectrum sample"><SelectValue /></SelectTrigger>
              <SelectContent>
                {samples.map((candidate) => (
                  <SelectItem key={candidate.sampleId} value={candidate.sampleId}>{candidate.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="fm-mode-composition-inspector__control">
            <span>Scope</span>
            <Select value={scope} onValueChange={(value) => setScope(value as SpectrumScope)}>
              <SelectTrigger aria-label="Spectrum participation scope"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="global">Global</SelectItem>
                {dependencies.compatibleObjects.map((object) => (
                  <SelectItem key={object.targetId} value={object.targetId}>{object.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="fm-mode-composition-inspector__control">
            <span>Spectrum component</span>
            <SegmentedControl
              aria-label="Spectrum component"
              columns={4}
              options={[
                { label: "Total", value: "total" },
                { label: "δmₓ", value: "x" },
                { label: "δmᵧ", value: "y" },
                { label: "δm_z", value: "z" },
              ]}
              value={component}
              onValueChange={setComponent}
            />
          </div>
        </div>
        <FieldRow label="Encoding" value="Volume-weighted complex L2 participation" />
        <FieldRow label="Metric unit" value="1" />
        <FieldRow label="Resource status" value="Retain last valid spectrum during refresh" />
      </InspectorGroup>
      <InspectorGroup title="Spectrum points" badge={`${sample?.modes.length ?? 0} mode(s)`}>
        <div className="fm-mode-composition-inspector__table-wrap">
          <table aria-label="Eigen spectrum mode table" className="fm-mode-composition-inspector__table">
            <thead><tr><th>Mode</th><th>Frequency</th><th>Residual</th><th>Participation</th></tr></thead>
            <tbody>
              {sample?.modes.map((mode) => (
                <tr data-selected={mode.modeId === selectedModeId || undefined} key={mode.modeId}>
                  <td><Button aria-label={`Select mode ${mode.modeId}`} size="sm" type="button" variant="ghost" onClick={() => setSelectedModeId(mode.modeId)}>{mode.rawModeIndex ?? mode.modeId}</Button></td>
                  <td>{formatFrequency(mode.frequencyHz)}</td>
                  <td>{formatResidual(mode.residualNorm)}</td>
                  <td>{scope === "global" ? "Global" : scope}; {componentLabel(component)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </InspectorGroup>
      <InspectorGroup title="Selected mode" badge={selectedMode?.modeId ?? "None"}>
        <FieldRow label="Assignment" value="Selecting a point does not change any object layer." />
        {selectedMode ? <FieldRow label="Field" value={selectedMode.fieldId ?? "Mode field unavailable"} /> : null}
      </InspectorGroup>
    </div>
  );
}

export function ModeCompositionActiveInspectorPanel({
  dependencies,
  selection,
}: InspectorDependenciesProps) {
  const resource = dependencies?.resource;
  if (!dependencies || !resource) {
    return <ModeCompositionUnavailable selection={selection} surface="mode-composition-active" />;
  }
  const activeLayers = resource.layers.filter((layer) => layer.enabled);
  const controller = dependencies.controller;
  const setAllEnabled = (enabled: boolean) => {
    if (!controller) return;
    void Promise.all(resource.layers.map((layer) => controller.updateLayer({ ...layer, enabled })));
  };

  return (
    <div className="fm-mode-composition-inspector" data-inspector-surface="mode-composition-active">
      <InspectorGroup title="Active Mode Composition" badge={`revision ${resource.revision}`}>
        <FieldRow label="Composition" value={resource.composition_id} />
        <FieldRow label="Dataset" value={`${resource.run_id} / ${resource.stage_id} / ${resource.artifact_revision}`} />
        <FieldRow label="Mesh lifecycle" value={`artifact ${resource.lifecycle.artifact_revision}, mesh ${resource.lifecycle.mesh_revision}`} />
        <div className="fm-mode-composition-inspector__inline-control">
          <Switch
            aria-label="Synchronize mode composition phase clock"
            checked={resource.phase_clock.synchronized}
            disabled={!controller}
            onCheckedChange={(synchronized) => controller && void controller.setPhaseClock({ ...resource.phase_clock, synchronized })}
          />
          <span>Synchronize phase clock ({resource.phase_clock.master_rate_hz} Hz)</span>
        </div>
        <div className="fm-mode-composition-inspector__actions">
          <Button disabled={!controller || activeLayers.length === 0} size="sm" type="button" variant="secondary" onClick={() => setAllEnabled(false)}>Hide all modal layers</Button>
          <Button disabled={!controller || resource.layers.length === 0} size="sm" type="button" variant="secondary" onClick={() => setAllEnabled(false)}>Restore base visualization</Button>
          <Button disabled={!controller || resource.layers.length === 0} size="sm" type="button" variant="danger" onClick={() => void controller?.mutate({ operations: [{ op: "clear_layers" }], target_ids: resource.layers.map((layer) => layer.target_id) })}>Clear composition</Button>
        </div>
      </InspectorGroup>
      <InspectorGroup title="Objects" badge={`${activeLayers.length} active`}>
        <div className="fm-mode-composition-inspector__table-wrap">
          <table aria-label="Active mode composition objects" className="fm-mode-composition-inspector__table">
            <thead><tr><th>Target</th><th>Mode</th><th>Component</th><th>State</th></tr></thead>
            <tbody>{resource.layers.map((layer) => <tr key={layer.layer_id}><td>{layer.target_id}</td><td>{layer.mode.mode_id}</td><td>{componentLabel(layer.component)}</td><td>{layer.enabled ? "Modal layer active" : "Base visualization"}</td></tr>)}</tbody>
          </table>
        </div>
      </InspectorGroup>
    </div>
  );
}

export function ModeCompositionObjectsInspectorPanel({
  dependencies,
  selection,
}: InspectorDependenciesProps) {
  if (!dependencies) return <ModeCompositionUnavailable selection={selection} surface="mode-composition-objects" />;
  const layers = dependencies.resource?.layers ?? [];
  return (
    <div className="fm-mode-composition-inspector" data-inspector-surface="mode-composition-objects">
      <InspectorGroup title="Mode composition objects" badge={`${dependencies.compatibleObjects.length} compatible`}>
        <FieldRow label="Field loading" value="Object collection never fetches a modal field." />
        <div className="fm-mode-composition-inspector__table-wrap">
          <table aria-label="Compatible mode composition objects" className="fm-mode-composition-inspector__table">
            <thead><tr><th>Object</th><th>Target</th><th>Layer</th><th>Effective surface</th></tr></thead>
            <tbody>{dependencies.compatibleObjects.map((object) => {
              const layer = layers.find((candidate) => candidate.target_id === object.targetId);
              return <tr key={object.targetId}><td>{object.label}</td><td>{object.targetId}</td><td>{layer?.mode.mode_id ?? "None"}</td><td>{effectiveSurfaceLabel(layer)}</td></tr>;
            })}</tbody>
          </table>
        </div>
      </InspectorGroup>
    </div>
  );
}

export function ModeCompositionObjectInspectorPanel({
  dependencies,
  selection,
}: InspectorDependenciesProps) {
  const objectRef =
    selection.ref?.type === "mode-composition-object" ? selection.ref : null;
  if (!dependencies || !objectRef) {
    return (
      <ModeCompositionUnavailable
        selection={selection}
        surface="mode-composition-object"
      />
    );
  }

  return (
    <ModeCompositionObjectLayerEditor
      dependencies={dependencies}
      objectRef={objectRef}
    />
  );
}

function ModeCompositionObjectLayerEditor({
  dependencies,
  objectRef,
}: {
  readonly dependencies: ModeCompositionInspectorDependencies;
  readonly objectRef: Extract<
    NonNullable<InspectorPanelProps["selection"]["ref"]>,
    { type: "mode-composition-object" }
  >;
}) {
  const object = dependencies.compatibleObjects.find((candidate) => candidate.targetId === objectRef.targetId) ?? {
    label: objectRef.objectId,
    objectId: objectRef.objectId,
    targetId: objectRef.targetId,
  };
  const layer = dependencies.resource?.layers.find((candidate) => candidate.target_id === object.targetId) ?? null;
  const samples = dependencies.spectrum?.samples ?? [];
  const [sampleId, setSampleId] = useState(layer?.mode.sample_id ?? samples[0]?.sampleId ?? "");
  const sample = samples.find((candidate) => candidate.sampleId === sampleId) ?? samples[0];
  const [modeId, setModeId] = useState(layer?.mode.mode_id ?? sample?.modes[0]?.modeId ?? "");
  const selectedMode = sample?.modes.find((mode) => mode.modeId === modeId) ?? sample?.modes[0] ?? null;
  const controller = dependencies.controller;
  const componentOptions = legalModeLayerComponents(layer?.representation ?? "phase_rotated_real");
  const canEnable = Boolean(controller && dependencies.resource && selectedMode?.fieldId);

  const enableLayer = () => {
    if (!controller || !dependencies.resource || !selectedMode?.fieldId || !sample) return;
    const nextLayer = layer ?? defaultLayer({ object, resource: dependencies.resource, sample, selectedMode });
    void controller.assign({ ...nextLayer, enabled: true });
  };
  const updateLayer = (patch: Partial<ModeCompositionLayer>) => {
    if (!controller || !layer) return;
    void controller.updateLayer({ ...layer, ...patch });
  };
  const updateRepresentation = (representation: ModeFieldRepresentation) => {
    if (!layer) return;
    const component = legalModeLayerComponents(representation).includes(layer.component)
      ? layer.component
      : "x";
    updateLayer({ appearance: { ...layer.appearance, ...eigenModeLayerAppearanceDefaults(representation) }, component, representation });
  };

  return (
    <div className="fm-mode-composition-inspector" data-inspector-surface="mode-composition-object">
      <InspectorGroup title="Object mode layer" badge={layer?.enabled ? "Active" : "Base"}>
        <FieldRow label="Object" value={object.label} />
        <FieldRow label="Target" value={object.targetId} />
        <FieldRow label="Layer" value={layer?.layer_id ?? "No mode layer"} />
        <FieldRow label="Configured surface" value="Base magnetic texture remains configured." />
        <FieldRow label="Effective surface" value={effectiveSurfaceLabel(layer)} />
        <FieldRow label="Field lifecycle" value={layer?.enabled ? "Preparing/ready state is owned by the render plan." : "idle"} />
        <Button disabled={!canEnable} size="sm" type="button" variant="primary" onClick={enableLayer}>Enable mode layer</Button>
      </InspectorGroup>
      <InspectorGroup title="Mode source" badge={selectedMode?.modeId ?? "Unavailable"}>
        <div className="fm-mode-composition-inspector__controls">
          <label className="fm-mode-composition-inspector__control"><span>Mode sample</span><Select value={sample?.sampleId ?? ""} onValueChange={(value) => { setSampleId(value); const next = samples.find((candidate) => candidate.sampleId === value); setModeId(next?.modes[0]?.modeId ?? ""); }}><SelectTrigger aria-label="Mode sample"><SelectValue /></SelectTrigger><SelectContent>{samples.map((candidate) => <SelectItem key={candidate.sampleId} value={candidate.sampleId}>{candidate.label}</SelectItem>)}</SelectContent></Select></label>
          <label className="fm-mode-composition-inspector__control"><span>Mode</span><Select value={selectedMode?.modeId ?? ""} onValueChange={setModeId}><SelectTrigger aria-label="Mode selection"><SelectValue /></SelectTrigger><SelectContent>{sample?.modes.map((mode) => <SelectItem key={mode.modeId} value={mode.modeId}>{`Mode ${mode.rawModeIndex ?? mode.modeId} · ${formatFrequency(mode.frequencyHz)}`}</SelectItem>)}</SelectContent></Select></label>
        </div>
        <FieldRow label="Mode field" value={selectedMode?.fieldId ?? "Unavailable"} />
        <FieldRow label="Residual" value={formatResidual(selectedMode?.residualNorm)} />
      </InspectorGroup>
      <InspectorGroup title="Component and representation">
        <div className="fm-mode-composition-inspector__controls">
          <label className="fm-mode-composition-inspector__control"><span>Mode component</span><Select disabled={!layer} value={layer?.component ?? "x"} onValueChange={(value) => updateLayer({ component: value as ModeFieldComponent, appearance: { ...layer!.appearance, vectors_visible: value === "vector" ? true : layer!.appearance.vectors_visible } })}><SelectTrigger aria-label="Mode component"><SelectValue /></SelectTrigger><SelectContent>{componentOptions.map((component) => <SelectItem key={component} value={component}>{componentLabel(component)}</SelectItem>)}</SelectContent></Select></label>
          <label className="fm-mode-composition-inspector__control"><span>Mode representation</span><Select disabled={!layer} value={layer?.representation ?? "phase_rotated_real"} onValueChange={(value) => updateRepresentation(value as ModeFieldRepresentation)}><SelectTrigger aria-label="Mode representation"><SelectValue /></SelectTrigger><SelectContent>{representationOptions().map((representation) => <SelectItem key={representation} value={representation}>{representationLabel(representation)}</SelectItem>)}</SelectContent></Select></label>
          <label className="fm-mode-composition-inspector__control"><span>Mode palette</span><Select disabled={!layer} value={layer?.appearance.colormap ?? "coolwarm"} onValueChange={(colormap) => layer && updateLayer({ appearance: { ...layer.appearance, colormap } })}><SelectTrigger aria-label="Mode palette"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="coolwarm">Coolwarm</SelectItem><SelectItem value="viridis">Viridis</SelectItem><SelectItem value="twilight">Twilight</SelectItem></SelectContent></Select></label>
        </div>
        <FieldRow label="Projection legality" value={layer?.component === "vector" ? "Vector is glyph-only and never becomes a scalar surface." : "Component is a scalar modal surface."} />
      </InspectorGroup>
      <InspectorGroup title="Phase and animation">
        <div className="fm-mode-composition-inspector__controls">
          <label className="fm-mode-composition-inspector__control"><span>Phase (rad)</span><Slider aria-label="Phase (rad)" disabled={!layer} max={Math.PI} min={-Math.PI} step={0.01} value={[layer?.phase_rad ?? 0]} onValueChange={([phase_rad]) => updateLayer({ phase_rad })} /></label>
          <label className="fm-mode-composition-inspector__control"><span>Animation rate (Hz)</span><input aria-label="Animation rate (Hz)" className="fm-mode-composition-inspector__number" disabled={!layer} min="0" step="0.1" type="number" value={layer?.animation.rate_hz ?? 0} onChange={(event) => { const rate_hz = Number(event.target.value); if (Number.isFinite(rate_hz) && rate_hz >= 0 && layer) updateLayer({ animation: { ...layer.animation, rate_hz } }); }} /></label>
          <div className="fm-mode-composition-inspector__inline-control"><Switch aria-label="Animate mode layer" checked={layer?.animation.enabled ?? false} disabled={!layer} onCheckedChange={(enabled) => layer && updateLayer({ animation: { ...layer.animation, enabled } })} /><span>Animate mode layer</span></div>
        </div>
      </InspectorGroup>
      <InspectorGroup title="Appearance">
        <div className="fm-mode-composition-inspector__controls">
          <label className="fm-mode-composition-inspector__control"><span>Opacity</span><Slider aria-label="Mode opacity" disabled={!layer} max={1} min={0} step={0.01} value={[layer?.appearance.opacity ?? 1]} onValueChange={([opacity]) => layer && updateLayer({ appearance: { ...layer.appearance, opacity } })} /></label>
          <div className="fm-mode-composition-inspector__inline-control"><Switch aria-label="Show mode colorbar" checked={layer?.appearance.colorbar_visible ?? false} disabled={!layer} onCheckedChange={(colorbar_visible) => layer && updateLayer({ appearance: { ...layer.appearance, colorbar_visible } })} /><span>Show colorbar</span></div>
          <div className="fm-mode-composition-inspector__inline-control"><Switch aria-label="Show modal vectors" checked={layer?.appearance.vectors_visible ?? false} disabled={!layer || !SIGNED_REPRESENTATIONS.has(layer.representation)} onCheckedChange={(vectors_visible) => layer && updateLayer({ appearance: { ...layer.appearance, vectors_visible } })} /><span>Show modal vectors</span></div>
        </div>
      </InspectorGroup>
    </div>
  );
}

function ModeCompositionUnavailable({ selection, surface }: { readonly selection: InspectorPanelProps["selection"]; readonly surface: string }) {
  return <div className="fm-mode-composition-inspector" data-inspector-surface={surface}><InspectorGroup title="Mode composition"><FieldRow label="Selection" value={selection.nodeId} /><p className="fm-mode-composition-inspector__unavailable" role="status">Mode composition resource unavailable. The Results selection is preserved; no visualization mutation was submitted.</p></InspectorGroup></div>;
}

function defaultLayer({ object, resource, sample, selectedMode }: { readonly object: ModeCompositionCompatibleObject; readonly resource: ModeCompositionResource; readonly sample: ModeCompositionSpectrumSample; readonly selectedMode: ModeCompositionSpectrumMode }): ModeCompositionLayer {
  return {
    amplitude_scale: 1,
    animation: { enabled: false, phase_offset_rad: 0, rate_hz: resource.phase_clock.master_rate_hz, synchronized: resource.phase_clock.synchronized },
    appearance: eigenModeLayerAppearanceDefaults("phase_rotated_real"),
    component: "x",
    enabled: true,
    field_id: selectedMode.fieldId!,
    layer_id: `mode-layer:${object.objectId}`,
    mode: { artifact_revision: resource.artifact_revision, branch_id: selectedMode.branchId, mode_id: selectedMode.modeId, raw_mode_index: selectedMode.rawModeIndex, run_id: resource.run_id, sample_id: sample.sampleId, stage_id: resource.stage_id },
    normalization: "mode_global_max",
    object_id: object.objectId,
    phase_rad: 0,
    representation: "phase_rotated_real",
    target_id: object.targetId,
  };
}

function effectiveSurfaceLabel(layer: ModeCompositionLayer | null | undefined): string {
  if (!layer?.enabled) return "Base visualization";
  return layer.component === "vector" ? "Base visualization with modal vectors" : "suppressed by mode layer";
}

function formatFrequency(frequencyHz: number): string { return `${(frequencyHz / 1e9).toFixed(6)} GHz`; }
function formatResidual(residual: number | undefined): string { return residual === undefined ? "Not published" : residual.toExponential(3); }
function componentLabel(component: ModeFieldComponent | SpectrumComponent): string {
  if (component === "total") return "Total";
  if (component === "magnitude") return "|δm|";
  if (component === "vector") return "Vector";
  return `δm_${component}`;
}
function representationLabel(representation: ModeFieldRepresentation): string {
  return ({ phase_rotated_real: "Phase-rotated real", real: "Real", imag: "Imaginary", abs: "Magnitude", phase: "Phase" })[representation];
}
function representationOptions(): readonly ModeFieldRepresentation[] { return ["phase_rotated_real", "real", "imag", "abs", "phase"]; }
