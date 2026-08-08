"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";

import type { SceneSpinTransport, TransportValidationRequest, TransportValidationResponse } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  SPIN_INTERFACES_RESOURCE_KEY,
  SPIN_TRANSPORTS_RESOURCE_KEY,
  invalidateSpinAuthoringResources,
  useSpinInterfacesResource,
  useSpinTransportsResource,
} from "@/kernel/resources/spinAuthoringResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { PhysicsInspectorOverview } from "./PhysicsInspectorOverview";
import { buildPhysicsInspectorOverviewModel } from "./PhysicsInspectorOverviewModel";

interface InterfaceDraft {
  absorption: string;
  ferromagnetObject: string;
  ferromagnetRegion: string;
  formulaVersion: string;
  gDown: string;
  gI: string;
  gR: string;
  gN: string;
  gF: string;
  gLattice: string;
  gUp: string;
  id: string;
  kind: "transparent" | "mixing_conductance";
  normalObject: string;
  normalRegion: string;
  normalToFerromagnet: string;
  normalAToB: string;
  sideAObject: string;
  sideARegion: string;
  sideBObject: string;
  sideBRegion: string;
}

const DEFAULT_INTERFACE: InterfaceDraft = {
  absorption: "transverse_absorption.fullmag.v1",
  ferromagnetObject: "",
  ferromagnetRegion: "",
  formulaVersion: "magnetoelectronic.fullmag.v2",
  gDown: "0",
  gI: "0",
  gR: "0",
  gN: "",
  gF: "",
  gLattice: "",
  gUp: "0",
  id: "interface",
  kind: "transparent",
  normalObject: "",
  normalRegion: "",
  normalToFerromagnet: "1, 0, 0",
  normalAToB: "1, 0, 0",
  sideAObject: "",
  sideARegion: "",
  sideBObject: "",
  sideBRegion: "",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string { return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value); }
function vectorText(value: unknown): string { return Array.isArray(value) ? value.join(", ") : ""; }
function finite(value: string, label: string): number { const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite.`); return parsed; }
function vector(value: string, label: string): number[] { const parsed = value.split(/[\s,]+/).filter(Boolean).map(Number); if (parsed.length !== 3 || parsed.some((entry) => !Number.isFinite(entry))) throw new Error(`${label} requires three finite components.`); return parsed; }

function region(value: unknown) {
  const item = record(value);
  return { object: text(item?.object_id), region: text(item?.region_id) };
}

function interfaceDraft(value: unknown): InterfaceDraft {
  const item = record(value);
  if (!item || (item.kind !== "transparent" && item.kind !== "mixing_conductance")) return DEFAULT_INTERFACE;
  const sideA = region(item.side_a);
  const sideB = region(item.side_b);
  const normal = region(item.normal_side);
  const ferromagnet = region(item.ferromagnet_side);
  return {
    absorption: text(item.absorption),
    ferromagnetObject: ferromagnet.object,
    ferromagnetRegion: ferromagnet.region,
    formulaVersion: text(item.formula_version),
    gDown: text(item.g_down_Spm2),
    gI: text(item.g_i_Spm2),
    gR: text(item.g_r_Spm2),
    gN: text(record(item.spin_memory_loss)?.g_n_Spm2),
    gF: text(record(item.spin_memory_loss)?.g_f_Spm2),
    gLattice: text(record(item.spin_memory_loss)?.g_lattice_Spm2),
    gUp: text(item.g_up_Spm2),
    id: text(item.id),
    kind: item.kind,
    normalObject: normal.object,
    normalRegion: normal.region,
    normalToFerromagnet: vectorText(item.normal_to_ferromagnet),
    normalAToB: vectorText(item.normal_a_to_b),
    sideAObject: sideA.object,
    sideARegion: sideA.region,
    sideBObject: sideB.object,
    sideBRegion: sideB.region,
  };
}

function regionRef(objectId: string, regionId: string) {
  if (!objectId.trim()) throw new Error("Region object id is required.");
  return { object_id: objectId, ...(regionId.trim() ? { region_id: regionId } : {}) };
}

function buildInterface(draft: InterfaceDraft): unknown {
  if (!draft.id.trim()) throw new Error("Interface id is required.");
  return draft.kind === "transparent" ? {
    id: draft.id,
    kind: draft.kind,
    side_a: regionRef(draft.sideAObject, draft.sideARegion),
    side_b: regionRef(draft.sideBObject, draft.sideBRegion),
    normal_a_to_b: vector(draft.normalAToB, "Interface orientation"),
  } : {
    id: draft.id,
    kind: draft.kind,
    normal_side: regionRef(draft.normalObject, draft.normalRegion),
    ferromagnet_side: regionRef(draft.ferromagnetObject, draft.ferromagnetRegion),
    normal_to_ferromagnet: vector(draft.normalToFerromagnet, "Interface orientation"),
    g_up_Spm2: finite(draft.gUp, "g_up"),
    g_down_Spm2: finite(draft.gDown, "g_down"),
    g_r_Spm2: finite(draft.gR, "g_r"),
    g_i_Spm2: finite(draft.gI, "g_i"),
    formula_version: draft.formulaVersion,
    absorption: draft.absorption,
    ...(draft.gN.trim() || draft.gF.trim() || draft.gLattice.trim() ? {
      spin_memory_loss: {
        g_n_Spm2: finite(draft.gN, "g_n"),
        g_f_Spm2: finite(draft.gF, "g_f"),
        g_lattice_Spm2: finite(draft.gLattice, "g_lattice"),
        formula_version: "sml_reservoir.fullmag.v2",
      },
    } : {}),
  };
}

export function SpinInterfaceInspectorPanel({ selection }: InspectorPanelProps) {
  const { api, resources } = useKernel();
  const projected = useSpinInterfacesResource();
  const transports = useSpinTransportsResource();
  const ref = selection.ref?.type === "spin-interface" && selection.ref.spinInterfaceIndex !== undefined
    ? selection.ref
    : null;
  const [localOwnerId, setLocalOwnerId] = useState("");
  const [localInterfaceId, setLocalInterfaceId] = useState("");
  const ownerId = ref?.spinInterfaceOwnerId ?? localOwnerId;
  const selected = useMemo(() => {
    const items = projected.data?.items ?? [];
    if (ref?.spinInterfaceIndex !== undefined) return items[ref.spinInterfaceIndex] ?? null;
    return items.find((item) => item.owner_spin_transport_id === ownerId && item.interface_id === localInterfaceId) ?? null;
  }, [localInterfaceId, ownerId, projected.data?.items, ref?.spinInterfaceIndex]);
  const baseDraft = interfaceDraft(selected?.interface);
  const draftKey = `${ownerId}:${selected?.interface_id ?? "new"}:${JSON.stringify(baseDraft)}`;
  const [draftState, setDraftState] = useState({ key: draftKey, value: baseDraft });
  const draft = draftState.key === draftKey ? draftState.value : baseDraft;
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const validationKey = `${draftKey}:${transports.data?.scene_revision ?? "none"}`;
  const [validationState, setValidationState] = useState<{ key: string; response: TransportValidationResponse | null }>({ key: "", response: null });
  const validation = validationState.key === validationKey ? validationState.response : null;
  const readOnly = selected ? !selected.known : false;
  const capability = useSessionStatusSelector((status) => status.data?.capabilities.transport_authoring?.m1_one_way_steady ?? null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseDraft);
  const valid = Boolean(
    !readOnly &&
      ownerId &&
      transports.status === "ready" &&
      capability?.authoring_allowed &&
      validation?.semantic.valid === true &&
      validation?.execution.authoring_allowed === true,
  );
  const lockReason = readOnly
    ? "Unknown interface payloads are read-only."
    : !ownerId
      ? "Select the owning spin transport before applying."
      : transports.status !== "ready"
        ? "Spin transport resources are not ready."
        : !capability?.authoring_allowed
          ? capability?.reason ?? "Authoring capability is unavailable."
          : undefined;

  const validationRequest = (): TransportValidationRequest => {
    if (!ownerId || transports.data?.scene_revision === undefined) throw new Error("Select the owning spin transport.");
    return {
      base_revision: transports.data.scene_revision,
      candidate: { interface_id: selected?.interface_id ?? null, kind: "spin_interface", operation: selected ? "replace" : "create", owner_spin_transport_id: ownerId, resource: buildInterface(draft) },
      validation_version: "transport-authoring-validation.v1",
    };
  };

  useEffect(() => {
    if (readOnly || !ownerId || transports.data?.scene_revision === undefined) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      try { void api.model.validateTransport(validationRequest(), { signal: controller.signal }).then((response) => setValidationState({ key: validationKey, response })).catch(() => setValidationState({ key: validationKey, response: null })); } catch { setValidationState({ key: validationKey, response: null }); }
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  // Serialized draft is the validation dependency by design.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, draft, ownerId, readOnly, selected?.interface_id, transports.data?.scene_revision, validationKey]);

  function ownerWith(nextInterface: unknown | null): SceneSpinTransport {
    const owner = (transports.data?.items ?? []).find((item) => record(item)?.id === ownerId);
    const ownerRecord = record(owner);
    if (!owner || !ownerRecord || !Array.isArray(ownerRecord.interfaces)) throw new Error("The owning spin transport is unavailable or read-only.");
    const selectedIndex = selected ? ownerRecord.interfaces.findIndex((item) => record(item)?.id === selected.interface_id) : -1;
    const interfaces = selectedIndex >= 0
      ? nextInterface === null ? ownerRecord.interfaces.filter((_, index) => index !== selectedIndex) : ownerRecord.interfaces.map((item, index) => index === selectedIndex ? nextInterface : item)
      : nextInterface === null ? ownerRecord.interfaces : [...ownerRecord.interfaces, nextInterface];
    return { ...ownerRecord, interfaces } as SceneSpinTransport;
  }

  async function validateOwner(resource: SceneSpinTransport) {
    if (transports.data?.scene_revision === undefined) throw new Error("Scene revision is unavailable.");
    const response = await api.model.validateTransport({ base_revision: transports.data.scene_revision, candidate: { kind: "spin_transport", operation: "replace", path_id: ownerId, resource }, validation_version: "transport-authoring-validation.v1" });
    if (!response.semantic.valid || !response.execution.authoring_allowed) throw new Error(response.semantic.issues[0]?.message ?? response.execution.reason ?? "Owner update is not authoring-ready.");
  }

  async function run(action: "save" | "delete"): Promise<boolean> {
    setPending(true);
    setFeedback(null);
    try {
      if (!capability?.authoring_allowed) throw new Error(capability?.reason ?? "Authoring capability is unavailable.");
      const nextInterface = action === "delete" ? null : buildInterface(draft);
      if (nextInterface) {
        const checked = await api.model.validateTransport(validationRequest());
        setValidationState({ key: validationKey, response: checked });
        if (!checked.semantic.valid || !checked.execution.authoring_allowed) throw new Error(checked.semantic.issues[0]?.message ?? checked.execution.reason ?? "Interface is not authoring-ready.");
      } else if (validation?.execution.authoring_allowed !== true) throw new Error("Latest clone-only validation does not permit mutation.");
      const resource = ownerWith(nextInterface);
      await validateOwner(resource);
      const commit = await api.model.replaceSpinTransport(ownerId, { base_revision: transports.data!.scene_revision, resource });
      invalidateSpinAuthoringResources(resources, commit, [
        SPIN_TRANSPORTS_RESOURCE_KEY,
        SPIN_INTERFACES_RESOURCE_KEY,
      ]);
      setFeedback({ kind: "success", message: action === "delete" ? "Interface deleted through its owning spin transport." : "Interface committed through its owning spin transport." });
      return true;
    } catch (error) { setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) }); return false; }
    finally { setPending(false); }
  }

  function resetDraft(): void {
    setDraftState({ key: draftKey, value: baseDraft });
    setFeedback(null);
  }

  useRegisterInspectorEditSession(
    "staged",
    pending,
    dirty,
    valid,
    lockReason,
    () => run("save"),
    resetDraft,
  );

  const patch = (value: Partial<InterfaceDraft>) => setDraftState({ key: draftKey, value: { ...draft, ...value } });
  const selectedRecord = record(selected?.interface);
  const selectedSideA = region(selectedRecord?.side_a);
  const selectedSideB = region(selectedRecord?.side_b);
  const overviewModel = buildPhysicsInspectorOverviewModel({
    family: "spin_interface",
    scope: {
      kind: selectedSideA.object && selectedSideB.object
        ? "cross_object"
        : "interface",
      sideA: selectedSideA.object,
      sideB: selectedSideB.object,
      stableRef: selected?.interface_id
        ? `interface:${selected.interface_id}`
        : "interface:new",
    },
    source: {
      id: selected?.interface_id ?? "new",
      kind: "spin_interface",
      status: readOnly ? "unsupported" : "active",
    },
    status: readOnly ? "unsupported" : "active",
  });
  return <PhysicsInspectorOverview model={overviewModel} primary={<div className="fm-inspector-panel"><InspectorGroup title="Spin interface">
    {!ref ? <><FormField label="Owning spin transport" type="select" value={ownerId} onChange={(event) => { setLocalOwnerId(event.target.value); setLocalInterfaceId(""); }}><option value="">Select owner</option>{(transports.data?.items ?? []).map((item, index) => { const id = record(item)?.id; return typeof id === "string" ? <option key={`${id}:${index}`} value={id}>{id}</option> : null; })}</FormField><FormField label="Interface" type="select" value={localInterfaceId} onChange={(event) => setLocalInterfaceId(event.target.value)}><option value="">New interface</option>{(projected.data?.items ?? []).filter((item) => item.owner_spin_transport_id === ownerId).map((item, index) => <option key={`${item.interface_id}:${index}`} value={item.interface_id ?? ""}>{item.interface_id ?? `Unknown ${index + 1}`}</option>)}</FormField></> : null}
    {readOnly && selected ? <><FeedbackBanner kind="warning" message="Unknown interface payload is preserved losslessly and read-only." /><FormField label="Opaque payload" type="textarea" rows={20} readOnly value={JSON.stringify(selected.interface, null, 2)} /></> : <InterfaceFields draft={draft} patch={patch} />}
    {!readOnly ? <div className="fm-help-text"><div>Owner: {ownerId || "not selected"}</div><div>Qualification: {validation?.execution.qualification ?? capability?.status ?? "checking"}</div><div>{validation?.execution.reason ?? capability?.reason ?? "Capability unavailable."}</div></div> : null}
    {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    {!readOnly ? <Button disabled={pending || !ownerId || !capability?.authoring_allowed || validation?.semantic.valid !== true || validation.execution.authoring_allowed !== true} onClick={() => void run("save")}>{pending ? "Committing…" : selected ? "Replace" : "Create"}</Button> : null}
    {selected && !readOnly ? <Button variant="danger" disabled={pending || !capability?.authoring_allowed || validation?.execution.authoring_allowed !== true} onClick={() => void run("delete")}>Delete</Button> : null}
  </InspectorGroup></div>} />;
}

function InterfaceFields({ draft, patch }: { draft: InterfaceDraft; patch: (value: Partial<InterfaceDraft>) => void }) {
  const field = (key: keyof InterfaceDraft) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => patch({ [key]: event.target.value });
  return <>
    <FormField label="Interface id" value={draft.id} onChange={field("id")} />
    <FormField label="Interface model" type="select" value={draft.kind} onChange={field("kind")}><option value="transparent">Transparent</option><option value="mixing_conductance">Mixing conductance</option></FormField>
    {draft.kind === "transparent" ? <>
      <FormField label="Source object" value={draft.sideAObject} onChange={field("sideAObject")} /><FormField label="Source region" value={draft.sideARegion} onChange={field("sideARegion")} />
      <FormField label="Target object" value={draft.sideBObject} onChange={field("sideBObject")} /><FormField label="Target region" value={draft.sideBRegion} onChange={field("sideBRegion")} />
      <FormField label="Source-to-target orientation" value={draft.normalAToB} onChange={field("normalAToB")} />
    </> : <>
      <FormField label="Normal-metal object" value={draft.normalObject} onChange={field("normalObject")} /><FormField label="Normal-metal region" value={draft.normalRegion} onChange={field("normalRegion")} />
      <FormField label="Ferromagnet object" value={draft.ferromagnetObject} onChange={field("ferromagnetObject")} /><FormField label="Ferromagnet region" value={draft.ferromagnetRegion} onChange={field("ferromagnetRegion")} />
      <FormField label="Normal-to-ferromagnet orientation" value={draft.normalToFerromagnet} onChange={field("normalToFerromagnet")} />
      <FormField label="g_up" unit="S/m²" value={draft.gUp} onChange={field("gUp")} /><FormField label="g_down" unit="S/m²" value={draft.gDown} onChange={field("gDown")} />
      <FormField label="g_r" unit="S/m²" value={draft.gR} onChange={field("gR")} /><FormField label="g_i" unit="S/m²" value={draft.gI} onChange={field("gI")} />
      <FormField label="SML g_n" unit="S/m²" value={draft.gN} onChange={field("gN")} /><FormField label="SML g_f" unit="S/m²" value={draft.gF} onChange={field("gF")} /><FormField label="SML g_lattice" unit="S/m²" value={draft.gLattice} onChange={field("gLattice")} />
      <FormField label="Formula version" value={draft.formulaVersion} onChange={field("formulaVersion")} /><FormField label="Absorption model" value={draft.absorption} onChange={field("absorption")} />
    </>}
  </>;
}
