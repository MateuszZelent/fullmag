"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";

import type {
  SceneOerstedField,
  SceneSpinTorque,
  TransportValidationRequest,
  TransportValidationResponse,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  OERSTED_FIELDS_RESOURCE_KEY,
  SPIN_TORQUES_RESOURCE_KEY,
  invalidateSpinAuthoringResources,
  useOerstedFieldsResource,
  useSpinTorquesResource,
} from "@/kernel/resources/spinAuthoringResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { PhysicsInspectorOverview } from "./PhysicsInspectorOverview";
import { buildPhysicsInspectorOverviewModel } from "./PhysicsInspectorOverviewModel";
import type { PhysicsInteractionId } from "./PhysicsInteractionPanelModel";
import { isUnsupportedSpinAuthoringResource } from "./SpinAuthoringInspectorModel";

type Family = "spin_torque" | "oersted_field";
type SpinResource = SceneSpinTorque | SceneOerstedField;

interface TorqueDraft {
  beta: string;
  compatibilityOrigin: string;
  currentDensity: string;
  currentSource: string;
  degree: string;
  drive: string;
  epsilonPrime: string;
  fixedLayerPosition: string;
  formulaVersion: string;
  freeLayerThickness: string;
  id: string;
  kind: "zhang_li" | "slonczewski" | "prescribed_sot";
  lambdaAsymmetry: string;
  rawSpinPolarization: string;
  realization: string;
  schemaVersion: string;
  spinPolarization: string;
  stackNormal: string;
  target: string;
  xiDl: string;
  xiFl: string;
}

interface OerstedDraft {
  axis: string;
  center: string;
  current: string;
  id: string;
  kind: "oersted_cylinder" | "oersted_field";
  model: "from_current_solution";
  radius: string;
  source: string;
  timeDependence: string;
}

const DEFAULT_TORQUE: TorqueDraft = {
  beta: "0",
  compatibilityOrigin: "",
  currentDensity: "0, 0, 0",
  currentSource: "",
  degree: "0.4",
  drive: JSON.stringify({ kind: "signed_scalar", current_density_Apm2: 0, sigma_hat: [0, 1, 0] }, null, 2),
  epsilonPrime: "0",
  fixedLayerPosition: "",
  formulaVersion: "slonczewski.fullmag.v2",
  freeLayerThickness: "",
  id: "spin-torque",
  kind: "zhang_li",
  lambdaAsymmetry: "1",
  rawSpinPolarization: "",
  realization: "",
  schemaVersion: "",
  spinPolarization: "0, 0, 1",
  stackNormal: "",
  target: "",
  xiDl: "0",
  xiFl: "0",
};

const DEFAULT_OERSTED: OerstedDraft = {
  axis: "0, 0, 1",
  center: "0, 0, 0",
  current: "0",
  id: "oersted-field",
  kind: "oersted_cylinder",
  model: "from_current_solution",
  radius: "1e-9",
  source: "",
  timeDependence: "",
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function jsonText(value: unknown): string {
  return value === null || value === undefined ? "" : JSON.stringify(value, null, 2);
}

function vectorText(value: unknown): string {
  return Array.isArray(value) ? value.join(", ") : "";
}

function parseVector(value: string, label: string): number[] {
  const parsed = value.split(/[\s,]+/).filter(Boolean).map(Number);
  if (parsed.length !== 3 || parsed.some((entry) => !Number.isFinite(entry))) throw new Error(`${label} requires three finite components.`);
  return parsed;
}

function finite(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite.`);
  return parsed;
}

function optionalJson(value: string): unknown | undefined {
  return value.trim() ? JSON.parse(value) : undefined;
}

function optionalVector(value: string, label: string): number[] | undefined {
  return value.trim() ? parseVector(value, label) : undefined;
}

function torqueDraft(value: SceneSpinTorque | null): TorqueDraft {
  const record = object(value);
  if (!value || isUnsupportedSpinAuthoringResource("spin_torque", record)) return DEFAULT_TORQUE;
  return {
    beta: text(record.beta),
    compatibilityOrigin: jsonText(record.compatibility_origin),
    currentDensity: vectorText(record.current_density),
    currentSource: text(record.current_source),
    degree: text(record.degree),
    drive: jsonText(record.drive),
    epsilonPrime: text(record.epsilon_prime),
    fixedLayerPosition: text(record.fixed_layer_position),
    formulaVersion: text(record.formula_version),
    freeLayerThickness: text(record.free_layer_thickness_m),
    id: text(record.id),
    kind: record.kind as TorqueDraft["kind"],
    lambdaAsymmetry: text(record.lambda_asymmetry),
    rawSpinPolarization: vectorText(record.raw_spin_polarization),
    realization: jsonText(record.realization),
    schemaVersion: text(record.schema_version),
    spinPolarization: vectorText(record.spin_polarization),
    stackNormal: vectorText(record.stack_normal),
    target: jsonText(record.target),
    xiDl: text(record.xi_dl),
    xiFl: text(record.xi_fl),
  };
}

function oerstedDraft(value: SceneOerstedField | null): OerstedDraft {
  const record = object(value);
  if (!value || isUnsupportedSpinAuthoringResource("oersted_field", record)) return DEFAULT_OERSTED;
  return {
    axis: vectorText(record.axis),
    center: vectorText(record.center),
    current: text(record.current),
    id: text(record.id),
    kind: record.kind as OerstedDraft["kind"],
    model: record.model === "from_current_solution" ? record.model : "from_current_solution",
    radius: text(record.radius),
    source: text(record.source),
    timeDependence: jsonText(record.time_dependence),
  };
}

export function buildTorque(draft: TorqueDraft): SceneSpinTorque {
  if (!draft.id.trim()) throw new Error("Torque id is required.");
  if (draft.kind === "zhang_li") return {
    kind: draft.kind,
    id: draft.id,
    current_density: optionalVector(draft.currentDensity, "Current density"),
    current_source: draft.currentSource.trim() ? draft.currentSource : undefined,
    degree: finite(draft.degree, "Degree"),
    beta: finite(draft.beta, "Beta"),
  };
  if (draft.kind === "slonczewski") return {
    kind: draft.kind,
    id: draft.id,
    current_density: optionalVector(draft.currentDensity, "Current density"),
    current_source: draft.currentSource.trim() ? draft.currentSource : undefined,
    degree: finite(draft.degree, "Degree"),
    epsilon_prime: finite(draft.epsilonPrime, "Epsilon prime"),
    fixed_layer_position: draft.fixedLayerPosition.trim() || undefined,
    formula_version: draft.formulaVersion as never,
    free_layer_thickness_m: draft.freeLayerThickness.trim() ? finite(draft.freeLayerThickness, "Free-layer thickness") : undefined,
    lambda_asymmetry: finite(draft.lambdaAsymmetry, "Lambda asymmetry"),
    realization: optionalJson(draft.realization) as never,
    schema_version: draft.schemaVersion.trim() || undefined,
    spin_polarization: parseVector(draft.spinPolarization, "Spin polarization"),
    stack_normal: optionalVector(draft.stackNormal, "Stack normal"),
    target: optionalJson(draft.target) as never,
  };
  return {
    kind: draft.kind,
    id: draft.id,
    compatibility_origin: optionalJson(draft.compatibilityOrigin) as never,
    drive: JSON.parse(draft.drive),
    formula_version: draft.formulaVersion as never,
    free_layer_thickness_m: finite(draft.freeLayerThickness, "Free-layer thickness"),
    raw_spin_polarization: optionalVector(draft.rawSpinPolarization, "Raw spin polarization"),
    schema_version: draft.schemaVersion as never,
    target: optionalJson(draft.target) as never,
    xi_dl: finite(draft.xiDl, "Damping-like efficiency"),
    xi_fl: finite(draft.xiFl, "Field-like efficiency"),
  };
}

function buildOersted(draft: OerstedDraft): SceneOerstedField {
  if (!draft.id.trim()) throw new Error("Oersted field id is required.");
  return draft.kind === "oersted_cylinder" ? {
    kind: draft.kind,
    id: draft.id,
    axis: parseVector(draft.axis, "Axis"),
    center: parseVector(draft.center, "Center"),
    current: finite(draft.current, "Current"),
    radius: finite(draft.radius, "Radius"),
    time_dependence: optionalJson(draft.timeDependence) as never,
  } : {
    kind: draft.kind,
    id: draft.id,
    model: draft.model,
    source: draft.source,
  };
}

function identity(value: SpinResource): string {
  return text(object(value).id);
}

export function SpinAuthoringInspector({ family, resourceId, resourceIndex }: {
  family: Extract<PhysicsInteractionId, Family>;
  resourceId?: string | null;
  resourceIndex?: number | null;
}) {
  const { api, resources } = useKernel();
  const torques = useSpinTorquesResource({ enabled: family === "spin_torque" });
  const oersted = useOerstedFieldsResource({ enabled: family === "oersted_field" });
  const active = family === "spin_torque" ? torques : oersted;
  const items = useMemo(() => (active.data?.items ?? []) as SpinResource[], [active.data]);
  const [localSelectedId, setLocalSelectedId] = useState("");
  const selectedId = resourceId ?? localSelectedId;
  const selected = (resourceIndex !== undefined && resourceIndex !== null ? items[resourceIndex] : items.find((item) => identity(item) === selectedId)) ?? null;
  const readOnly = selected ? isUnsupportedSpinAuthoringResource(family, object(selected)) : false;
  const baseDraft = family === "spin_torque" ? torqueDraft(selected as SceneSpinTorque | null) : oerstedDraft(selected as SceneOerstedField | null);
  const draftKey = `${family}:${resourceId ?? resourceIndex ?? localSelectedId}:${JSON.stringify(baseDraft)}`;
  const [draftState, setDraftState] = useState<{ key: string; value: TorqueDraft | OerstedDraft }>({ key: draftKey, value: baseDraft });
  const draft = draftState.key === draftKey ? draftState.value : baseDraft;
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const validationKey = `${draftKey}:${active.data?.scene_revision ?? "none"}`;
  const [validationState, setValidationState] = useState<{ key: string; response: TransportValidationResponse | null }>({ key: "", response: null });
  const validation = validationState.key === validationKey ? validationState.response : null;
  const capability = useSessionStatusSelector((status) => status.data?.capabilities.transport_authoring?.m1_one_way_steady ?? null);

  const resourceFromDraft = () => family === "spin_torque" ? buildTorque(draft as TorqueDraft) : buildOersted(draft as OerstedDraft);
  const validationRequest = (): TransportValidationRequest => {
    if (active.data?.scene_revision === undefined) throw new Error("Scene revision is unavailable.");
    const resource = resourceFromDraft();
    return {
      base_revision: active.data.scene_revision,
      candidate: family === "spin_torque"
        ? { kind: "spin_torque", operation: selectedId ? "replace" : "create", path_id: selectedId || null, resource: resource as SceneSpinTorque }
        : { kind: "oersted_field", operation: selectedId ? "replace" : "create", path_id: selectedId || null, resource: resource as SceneOerstedField },
      validation_version: "transport-authoring-validation.v1",
    };
  };

  useEffect(() => {
    if (readOnly || active.data?.scene_revision === undefined) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      try {
        void api.model.validateTransport(validationRequest(), { signal: controller.signal }).then((response) => setValidationState({ key: validationKey, response })).catch(() => setValidationState({ key: validationKey, response: null }));
      } catch {
        setValidationState({ key: validationKey, response: null });
      }
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  // Serialized draft is the validation dependency by design.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.data?.scene_revision, api, draft, family, readOnly, selectedId, validationKey]);

  const patch = (value: Partial<TorqueDraft> | Partial<OerstedDraft>) => setDraftState({ key: draftKey, value: Object.assign({}, draft, value) as TorqueDraft | OerstedDraft });

  async function save(): Promise<void> {
    setPending(true);
    setFeedback(null);
    try {
      if (!capability?.authoring_allowed) throw new Error(capability?.reason ?? "Authoring capability is unavailable.");
      const checked = await api.model.validateTransport(validationRequest());
      setValidationState({ key: validationKey, response: checked });
      if (!checked.semantic.valid || !checked.execution.authoring_allowed) throw new Error(checked.semantic.issues[0]?.message ?? checked.execution.reason ?? "Candidate is not authoring-ready.");
      const resource = resourceFromDraft();
      const base_revision = active.data?.scene_revision;
      if (base_revision === undefined) throw new Error("Scene revision is unavailable.");
      let commit: { scene_revision: number };
      if (family === "spin_torque") {
        const request = { base_revision, resource: resource as SceneSpinTorque };
        if (selectedId) commit = await api.model.replaceSpinTorque(selectedId, request); else commit = await api.model.createSpinTorque(request);
      } else {
        const request = { base_revision, resource: resource as SceneOerstedField };
        if (selectedId) commit = await api.model.replaceOerstedField(selectedId, request); else commit = await api.model.createOerstedField(request);
      }
      invalidateSpinAuthoringResources(resources, commit, [family === "spin_torque" ? SPIN_TORQUES_RESOURCE_KEY : OERSTED_FIELDS_RESOURCE_KEY]);
      setFeedback({ kind: "success", message: "Authoring resource committed." });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally { setPending(false); }
  }

  async function remove(): Promise<void> {
    if (!selectedId || active.data?.scene_revision === undefined || readOnly) return;
    setPending(true);
    try {
      if (!capability?.authoring_allowed || validation?.execution.authoring_allowed !== true) throw new Error(capability?.reason ?? validation?.execution.reason ?? "Latest validation does not permit mutation.");
      const request = { base_revision: active.data.scene_revision };
      const commit = family === "spin_torque"
        ? await api.model.deleteSpinTorque(selectedId, request)
        : await api.model.deleteOerstedField(selectedId, request);
      invalidateSpinAuthoringResources(resources, commit, [family === "spin_torque" ? SPIN_TORQUES_RESOURCE_KEY : OERSTED_FIELDS_RESOURCE_KEY]);
      setLocalSelectedId("");
      setFeedback({ kind: "success", message: "Authoring resource deleted." });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally { setPending(false); }
  }

  return <div className="fm-inspector-panel"><InspectorGroup title={family === "spin_torque" ? "Spin torque" : "Oersted field"}>
    {resourceId === undefined && resourceIndex === undefined ? <FormField label="Resource" type="select" value={localSelectedId} onChange={(event) => setLocalSelectedId(event.target.value)}><option value="">New resource</option>{items.map((item, index) => <option key={`${identity(item)}:${index}`} value={identity(item)}>{identity(item) || `Unknown ${index + 1}`}</option>)}</FormField> : null}
    {readOnly && selected ? <><FeedbackBanner kind="warning" message="Unknown authoring record is preserved losslessly and is read-only." /><FormField label="Opaque payload" type="textarea" rows={20} readOnly value={JSON.stringify(selected, null, 2)} /></> : family === "spin_torque" ? <TorqueFields draft={draft as TorqueDraft} identityReadOnly={Boolean(selected)} patch={patch} /> : <OerstedFields draft={draft as OerstedDraft} identityReadOnly={Boolean(selected)} patch={patch} />}
    {!readOnly ? <div className="fm-help-text"><div>Qualification: {validation?.execution.qualification ?? capability?.status ?? "checking"}</div><div>{validation?.execution.reason ?? capability?.reason ?? "Capability unavailable."}</div></div> : null}
    {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    {!readOnly ? <Button disabled={pending || active.status !== "ready" || !capability?.authoring_allowed || validation?.semantic.valid !== true || validation.execution.authoring_allowed !== true} onClick={() => void save()}>{pending ? "Committing…" : selected ? "Replace" : "Create"}</Button> : null}
    {selected && !readOnly ? <Button disabled={pending || !capability?.authoring_allowed || validation?.execution.authoring_allowed !== true} variant="danger" onClick={() => void remove()}>Delete</Button> : null}
  </InspectorGroup></div>;
}

function TorqueFields({ draft, identityReadOnly, patch }: { draft: TorqueDraft; identityReadOnly: boolean; patch: (value: Partial<TorqueDraft> | Partial<OerstedDraft>) => void }) {
  const field = (key: keyof TorqueDraft) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => patch({ [key]: event.target.value });
  return <>
    <FormField label="Torque id" readOnly={identityReadOnly} value={draft.id} onChange={field("id")} />
    <FormField label="Torque model" type="select" value={draft.kind} onChange={(event) => event.target.value === "prescribed_sot" ? patch({ kind: "prescribed_sot", formulaVersion: "prescribed_sot.fullmag.v1", schemaVersion: "prescribed_sot.v1", freeLayerThickness: draft.freeLayerThickness || "1e-9" }) : field("kind")(event)}><option value="zhang_li">Zhang-Li</option><option value="slonczewski">Slonczewski</option><option value="prescribed_sot">Prescribed SOT</option></FormField>
    {draft.kind !== "prescribed_sot" ? <><FormField label="Current density" unit="A/m²" value={draft.currentDensity} onChange={field("currentDensity")} /><FormField label="Current source" value={draft.currentSource} onChange={field("currentSource")} /><FormField label="Polarization degree" value={draft.degree} onChange={field("degree")} /></> : null}
    {draft.kind === "zhang_li" ? <FormField label="Non-adiabaticity beta" value={draft.beta} onChange={field("beta")} /> : null}
    {draft.kind === "slonczewski" ? <>
      <FormField label="Spin polarization orientation" value={draft.spinPolarization} onChange={field("spinPolarization")} />
      <FormField label="Epsilon prime" value={draft.epsilonPrime} onChange={field("epsilonPrime")} />
      <FormField label="Lambda asymmetry" value={draft.lambdaAsymmetry} onChange={field("lambdaAsymmetry")} />
      <FormField label="Formula version" value={draft.formulaVersion} onChange={field("formulaVersion")} />
      <FormField label="Free-layer thickness" unit="m" value={draft.freeLayerThickness} onChange={field("freeLayerThickness")} />
      <FormField label="Stack normal orientation" value={draft.stackNormal} onChange={field("stackNormal")} />
      <FormField label="Target region" type="textarea" value={draft.target} onChange={field("target")} />
      <FormField label="Realization" type="textarea" value={draft.realization} onChange={field("realization")} />
      <FormField label="Schema version" value={draft.schemaVersion} onChange={field("schemaVersion")} />
      <FormField label="Fixed-layer position" value={draft.fixedLayerPosition} onChange={field("fixedLayerPosition")} />
    </> : null}
    {draft.kind === "prescribed_sot" ? <>
      <FormField label="SOT drive" type="textarea" rows={8} value={draft.drive} onChange={field("drive")} />
      <FormField label="Damping-like efficiency xi_dl" value={draft.xiDl} onChange={field("xiDl")} />
      <FormField label="Field-like efficiency xi_fl" value={draft.xiFl} onChange={field("xiFl")} />
      <FormField label="Formula version" value={draft.formulaVersion} onChange={field("formulaVersion")} />
      <FormField label="Schema version" value={draft.schemaVersion} onChange={field("schemaVersion")} />
      <FormField label="Free-layer thickness" unit="m" value={draft.freeLayerThickness} onChange={field("freeLayerThickness")} />
      <FormField label="Raw spin polarization orientation" value={draft.rawSpinPolarization} onChange={field("rawSpinPolarization")} />
      <FormField label="Target region" type="textarea" value={draft.target} onChange={field("target")} />
      <FormField label="Compatibility origin" type="textarea" value={draft.compatibilityOrigin} onChange={field("compatibilityOrigin")} />
    </> : null}
  </>;
}

function OerstedFields({ draft, identityReadOnly, patch }: { draft: OerstedDraft; identityReadOnly: boolean; patch: (value: Partial<TorqueDraft> | Partial<OerstedDraft>) => void }) {
  const field = (key: keyof OerstedDraft) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => patch({ [key]: event.target.value });
  return <>
    <FormField label="Oersted field id" readOnly={identityReadOnly} value={draft.id} onChange={field("id")} />
    <FormField label="Oersted model" type="select" value={draft.kind} onChange={field("kind")}><option value="oersted_cylinder">Analytic cylinder</option><option value="oersted_field">From current solution</option></FormField>
    {draft.kind === "oersted_cylinder" ? <>
      <FormField label="Center" unit="m" value={draft.center} onChange={field("center")} />
      <FormField label="Axis orientation" value={draft.axis} onChange={field("axis")} />
      <FormField label="Radius" unit="m" value={draft.radius} onChange={field("radius")} />
      <FormField label="Current" unit="A" value={draft.current} onChange={field("current")} />
      <FormField label="Time dependence" type="textarea" rows={7} value={draft.timeDependence} onChange={field("timeDependence")} />
    </> : <>
      <FormField label="Current solution source" value={draft.source} onChange={field("source")} />
      <FormField label="Field model" value={draft.model} readOnly />
    </>}
  </>;
}

export function SpinTorqueInspectorPanel({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "spin-torque" ? selection.ref : null;
  return (
    <PhysicsInspectorOverview
      model={buildPhysicsInspectorOverviewModel({
        family: "spin_torque",
        scope: {
          kind: selection.objectId ? "object" : "global",
          objectId: selection.objectId,
          stableRef: selection.objectId ? `object:${selection.objectId}` : "global:physics",
        },
        source: {
          id: ref?.spinTorqueId ?? "new",
          kind: "spin_torque",
          status: "active",
        },
        status: "active",
      })}
      primary={<SpinAuthoringInspector family="spin_torque" resourceId={ref?.spinTorqueId} resourceIndex={ref?.spinTorqueIndex} />}
    />
  );
}

export function OerstedFieldInspectorPanel({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "oersted-field" ? selection.ref : null;
  return (
    <PhysicsInspectorOverview
      model={buildPhysicsInspectorOverviewModel({
        family: "oersted_field",
        scope: {
          kind: selection.objectId ? "object" : "global",
          objectId: selection.objectId,
          stableRef: selection.objectId ? `object:${selection.objectId}` : "global:physics",
        },
        source: {
          id: ref?.oerstedFieldId ?? "new",
          kind: "oersted_field",
          status: "active",
        },
        status: "active",
      })}
      primary={<SpinAuthoringInspector family="oersted_field" resourceId={ref?.oerstedFieldId} resourceIndex={ref?.oerstedFieldIndex} />}
    />
  );
}
