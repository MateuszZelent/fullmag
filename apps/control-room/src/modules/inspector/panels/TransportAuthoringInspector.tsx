"use client";

import { useEffect, useMemo, useState, type ChangeEvent } from "react";

import type {
  SceneCurrentTransport,
  SceneSpinTransport,
  TransportAuthoringCapabilityMap,
  TransportValidationRequest,
  TransportValidationResponse,
} from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  invalidateSpinAuthoringResources,
  transportMutationResourceKeys,
  useCurrentTransportsResource,
  useSpinTransportsResource,
} from "@/kernel/resources/spinAuthoringResources";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import type { InspectorPanelProps } from "../inspectorTypes";
import {
  buildCurrentTransport,
  buildSpinTransport,
  currentTransportDraft,
  isKnownCurrentTransport,
  isKnownSpinTransport,
  readonlyTransportPayload,
  resolveTransportRecord,
  spinTransportDraft,
  transportIdentity,
  transportSelectionKey,
  type CurrentTransportDraft,
  type SpinTransportDraft,
} from "./TransportAuthoringInspectorModel";

type Family = "current_transport" | "spin_transport";
type Draft = CurrentTransportDraft | SpinTransportDraft;

const TRANSPORT_VALIDATION_VERSION = "transport-authoring-validation.v1";

function requestedCapability(
  family: Family,
  draft: Draft,
  capabilities: TransportAuthoringCapabilityMap | null,
) {
  if (!capabilities) return null;
  if (family === "current_transport") {
    return (draft as CurrentTransportDraft).coupling === "bidirectional"
      ? capabilities.m2_reciprocal
      : capabilities.m1_one_way_steady;
  }
  const spin = draft as SpinTransportDraft;
  if (spin.mode === "transient") return capabilities.m3_transient;
  if (spin.executionDevice === "gpu") return capabilities.gpu;
  if (spin.executionPrecision === "single") return capabilities.single_precision;
  if (spin.executionDiscretization === "hybrid" || spin.executionMode === "hybrid") {
    return capabilities.hybrid;
  }
  return capabilities.m1_one_way_steady;
}

export function TransportAuthoringInspector({
  family,
  resourceId,
  resourceIndex,
}: {
  family: Family;
  resourceId?: string | null;
  resourceIndex?: number | null;
}) {
  const { api, resources } = useKernel();
  const current = useCurrentTransportsResource({ enabled: family === "current_transport" });
  const spin = useSpinTransportsResource({ enabled: family === "spin_transport" });
  const active = family === "current_transport" ? current : spin;
  const items = useMemo(
    () => (active.data?.items ?? []) as (SceneCurrentTransport | SceneSpinTransport)[],
    [active.data],
  );
  const [localSelectionKey, setLocalSelectionKey] = useState("");
  const selected = resolveTransportRecord(family, items, {
    resourceId,
    resourceIndex,
    selectionKey: localSelectionKey,
  });
  const selectedId = resourceId ?? (selected ? transportIdentity(family, selected) : null);
  const known = selected
    ? family === "current_transport"
      ? isKnownCurrentTransport(selected as SceneCurrentTransport)
      : isKnownSpinTransport(selected as SceneSpinTransport)
    : true;
  const baseDraft = family === "current_transport"
    ? currentTransportDraft(selected && known ? selected as Parameters<typeof currentTransportDraft>[0] : null)
    : spinTransportDraft(selected && known ? selected as Parameters<typeof spinTransportDraft>[0] : null);
  const draftKey = `${family}:${resourceId ?? resourceIndex ?? localSelectionKey}:${JSON.stringify(baseDraft)}`;
  const [draftState, setDraftState] = useState<{ draft: Draft; key: string }>({
    draft: baseDraft,
    key: draftKey,
  });
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);
  const [pending, setPending] = useState(false);
  const validationKey = `${draftKey}:${active.data?.scene_revision ?? "none"}`;
  const [validationState, setValidationState] = useState<{ error: string | null; key: string; response: TransportValidationResponse | null }>({ error: null, key: "", response: null });
  const validation = validationState.key === validationKey ? validationState.response : null;
  const validationError = validationState.key === validationKey ? validationState.error : null;
  const capabilities = useSessionStatusSelector(
    (status) => status.data?.capabilities.transport_authoring ?? null,
    { enabled: true },
  );
  const capability = requestedCapability(family, draft, capabilities);

  function validationRequest(): TransportValidationRequest {
    if (active.data?.scene_revision === undefined) {
      throw new Error("Scene revision is unavailable.");
    }
    const operation = selectedId ? "replace" as const : "create" as const;
    return family === "current_transport"
      ? {
          base_revision: active.data.scene_revision,
          candidate: {
            kind: "current_transport",
            operation,
            path_id: selectedId,
            resource: buildCurrentTransport(draft as CurrentTransportDraft),
          },
          validation_version: TRANSPORT_VALIDATION_VERSION,
        }
      : {
          base_revision: active.data.scene_revision,
          candidate: {
            kind: "spin_transport",
            operation,
            path_id: selectedId,
            resource: buildSpinTransport(draft as SpinTransportDraft),
          },
          validation_version: TRANSPORT_VALIDATION_VERSION,
        };
  }

  useEffect(() => {
    if (!known || active.data?.scene_revision === undefined) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      try {
        const request = validationRequest();
        void api.model.validateTransport(request, { signal: controller.signal })
          .then((response) => {
            setValidationState({ error: null, key: validationKey, response });
          })
          .catch((error: unknown) => {
            if (!controller.signal.aborted) {
              setValidationState({ error: error instanceof Error ? error.message : String(error), key: validationKey, response: null });
            }
          });
      } catch (error) {
        setValidationState({ error: error instanceof Error ? error.message : String(error), key: validationKey, response: null });
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  // The serialized draft deliberately makes every semantic edit trigger clone-only validation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.data?.scene_revision, api, draft, family, known, selectedId, validationKey]);

  const patch = (value: Partial<Draft>) => setDraftState({
    draft: { ...draft, ...value } as Draft,
    key: draftKey,
  });

  async function save(): Promise<void> {
    if (active.data?.scene_revision === undefined) return;
    setPending(true);
    setFeedback(null);
    try {
      if (!capability?.authoring_allowed) {
        throw new Error(capability?.reason ?? "Transport authoring capability is unavailable.");
      }
      const checked = await api.model.validateTransport(validationRequest());
      setValidationState({ error: null, key: validationKey, response: checked });
      if (!checked.semantic.valid || !checked.execution.authoring_allowed) {
        throw new Error(
          checked.semantic.issues[0]?.message ?? checked.execution.reason ?? "Transport candidate is not authoring-ready.",
        );
      }
      let commit: { scene_revision: number };
      if (family === "current_transport") {
        const resource = buildCurrentTransport(draft as CurrentTransportDraft);
        const request = { base_revision: active.data.scene_revision, resource };
        if (selectedId) commit = await api.model.replaceCurrentTransport(selectedId, request);
        else commit = await api.model.createCurrentTransport(request);
      } else {
        const resource = buildSpinTransport(draft as SpinTransportDraft);
        const request = { base_revision: active.data.scene_revision, resource };
        if (selectedId) commit = await api.model.replaceSpinTransport(selectedId, request);
        else commit = await api.model.createSpinTransport(request);
      }
      invalidateSpinAuthoringResources(resources, commit, transportMutationResourceKeys(family));
      setFeedback({ kind: "success", message: "Transport resource committed." });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  }

  async function remove(): Promise<void> {
    if (!selectedId || active.data?.scene_revision === undefined) return;
    setPending(true);
    try {
      if (!capability?.authoring_allowed || validation?.semantic.valid !== true || validation.execution.authoring_allowed !== true) {
        throw new Error(capability?.reason ?? validation?.execution.reason ?? "Latest clone-only validation does not permit mutation.");
      }
      const request = { base_revision: active.data.scene_revision };
      const commit = family === "current_transport"
        ? await api.model.deleteCurrentTransport(selectedId, request)
        : await api.model.deleteSpinTransport(selectedId, request);
      invalidateSpinAuthoringResources(resources, commit, transportMutationResourceKeys(family));
      setLocalSelectionKey("");
      setFeedback({ kind: "success", message: "Transport resource deleted." });
    } catch (error) {
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title={family === "current_transport" ? "Charge transport" : "Spin transport"}>
        {resourceId === undefined || resourceId === null ? resourceIndex === undefined || resourceIndex === null ? (
          <FormField label="Resource" type="select" value={localSelectionKey} onChange={(event) => setLocalSelectionKey(event.target.value)}>
            <option value="">New resource</option>
            {items.map((item, index) => {
              const key = transportSelectionKey(family, item, index);
              const label = transportIdentity(family, item) ?? `Unknown ${family === "current_transport" ? "current" : "spin"} transport ${index + 1}`;
              return <option key={key} value={key}>{label}</option>;
            })}
          </FormField>
        ) : null : null}
        {!known && selected ? (
          <>
            <FeedbackBanner kind="warning" message="Unknown transport variant is preserved losslessly and is read-only." />
            <FormField label="Opaque payload" type="textarea" rows={20} readOnly value={readonlyTransportPayload(selected)} />
          </>
        ) : family === "current_transport" ? (
          <CurrentFields draft={draft as CurrentTransportDraft} identityReadOnly={Boolean(selected)} patch={patch} />
        ) : (
          <SpinFields draft={draft as SpinTransportDraft} identityReadOnly={Boolean(selected)} patch={patch} />
        )}
        {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
        {known ? <div className="fm-help-text" data-testid="transport-capability">
          <div>Qualification: {validation?.execution.qualification ?? capability?.status ?? "checking"}</div>
          <div>Requested lane: {validation?.execution.requested_lane ? JSON.stringify(validation.execution.requested_lane) : "semantic authoring"}</div>
          <div>Resolved lane: {validation?.execution.resolved_lane ? JSON.stringify(validation.execution.resolved_lane) : "not resolved"}</div>
          <div>{validationError ?? validation?.execution.reason ?? capability?.reason ?? "Capability status unavailable."}</div>
          {validation?.semantic.issues.map((issue) => <div key={`${issue.code}:${issue.path}`}>{issue.path}: {issue.message}</div>)}
        </div> : null}
        {known ? <Button disabled={pending || active.status !== "ready" || !capability?.authoring_allowed || validation?.semantic.valid !== true || validation.execution.authoring_allowed !== true} onClick={() => void save()}>
          {pending ? "Committing…" : selected ? "Replace" : "Create"}
        </Button> : null}
        {selected && known ? <Button disabled={pending || !capability?.authoring_allowed || validation?.semantic.valid !== true || validation.execution.authoring_allowed !== true} variant="danger" onClick={() => void remove()}>Delete</Button> : null}
      </InspectorGroup>
    </div>
  );
}

export function SpinTransportInspectorPanel({ selection }: InspectorPanelProps) {
  const resourceId = selection.ref?.type === "spin-transport"
    ? selection.ref.spinTransportId
    : null;
  const resourceIndex = selection.ref?.type === "spin-transport"
    ? selection.ref.spinTransportIndex
    : null;
  return <TransportAuthoringInspector family="spin_transport" resourceId={resourceId} resourceIndex={resourceIndex} />;
}

export function CurrentTransportInspectorPanel({ selection }: InspectorPanelProps) {
  const resourceId = selection.ref?.type === "current-transport"
    ? selection.ref.currentTransportId
    : null;
  const resourceIndex = selection.ref?.type === "current-transport"
    ? selection.ref.currentTransportIndex
    : null;
  return <TransportAuthoringInspector family="current_transport" resourceId={resourceId} resourceIndex={resourceIndex} />;
}

function CurrentFields({ draft, identityReadOnly, patch }: { draft: CurrentTransportDraft; identityReadOnly: boolean; patch: (value: Partial<Draft>) => void }) {
  const field = (key: keyof CurrentTransportDraft) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => patch({ [key]: event.target.value });
  return <>
    <FormField label="Name" readOnly={identityReadOnly} value={draft.name} onChange={field("name")} />
    <FormField label="Model" type="select" value={draft.model} onChange={field("model")}><option value="prescribed_density">Prescribed density</option><option value="ohmic_poisson">Ohmic Poisson</option></FormField>
    <FormField label="Coupling" type="select" value={draft.coupling} onChange={field("coupling")}><option value="one_way">One way</option><option value="bidirectional">Bidirectional</option></FormField>
    {draft.model === "prescribed_density" ? <FormField label="Current density vector" unit="A/m²" type="textarea" value={draft.currentDensity} onChange={field("currentDensity")} /> : <>
      <FormField label="Domain region refs" type="textarea" rows={5} value={draft.domain} onChange={field("domain")} />
      <FormField label="Material assignments (sigma_Spm)" type="textarea" rows={7} value={draft.materials} onChange={field("materials")} />
      <FormField label="Charge boundaries" type="textarea" rows={9} value={draft.boundaries} onChange={field("boundaries")} />
      <FormField label="Gauge" type="select" value={draft.gauge} onChange={field("gauge")}><option value="dirichlet_reference">Dirichlet reference</option><option value="zero_mean">Zero mean</option></FormField>
      <SolverFields draft={draft} field={field} />
    </>}
    <FormField label="Legacy solve region" value={draft.solveRegion} onChange={field("solveRegion")} />
    <FormField label="Legacy conductivity" unit="S/m" value={draft.conductivity} onChange={field("conductivity")} />
  </>;
}

function SpinFields({ draft, identityReadOnly, patch }: { draft: SpinTransportDraft; identityReadOnly: boolean; patch: (value: Partial<Draft>) => void }) {
  const field = (key: keyof SpinTransportDraft) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => patch({ [key]: event.target.value });
  return <>
    <FormField label="Id" readOnly={identityReadOnly} value={draft.id} onChange={field("id")} />
    <FormField label="Schema version" value={draft.schemaVersion} onChange={field("schemaVersion")} />
    <FormField label="Current source id" value={draft.currentSourceId} onChange={field("currentSourceId")} />
    <FormField label="Mode" type="select" value={draft.mode} onChange={field("mode")}><option value="steady">Steady</option><option value="transient">Transient</option></FormField>
    <FormField label="Domain region refs" type="textarea" rows={5} value={draft.domain} onChange={field("domain")} />
    <FormField label="Spin material assignments (includes spin_capacitance_As_per_V_m3 and capacitance_formula_version)" type="textarea" rows={9} value={draft.materials} onChange={field("materials")} />
    <FormField label="Interfaces" type="textarea" rows={9} value={draft.interfaces} onChange={field("interfaces")} />
    <FormField label="Spin boundaries" type="textarea" rows={9} value={draft.boundaries} onChange={field("boundaries")} />
    <SolverFields draft={draft} field={field} />
    <FormField label="Default external boundary" value={draft.solverDefaultExternalBoundary} onChange={field("solverDefaultExternalBoundary")} />
    <FormField label="Requested discretization" type="select" value={draft.executionDiscretization} onChange={field("executionDiscretization")}><option value="auto">Auto</option><option value="fdm">FDM</option><option value="fem">FEM</option><option value="hybrid">Hybrid</option></FormField>
    <FormField label="Requested device" type="select" value={draft.executionDevice} onChange={field("executionDevice")}><option value="auto">Auto</option><option value="cpu">CPU</option><option value="gpu">GPU</option></FormField>
    <FormField label="Requested precision" type="select" value={draft.executionPrecision} onChange={field("executionPrecision")}><option value="double">Double</option><option value="single">Single</option></FormField>
    <FormField label="Requested execution mode" type="select" value={draft.executionMode} onChange={field("executionMode")}><option value="strict">Strict</option><option value="extended">Extended</option><option value="hybrid">Hybrid</option></FormField>
    <FormField label="Constitutive version" value={draft.constitutiveVersion} onChange={field("constitutiveVersion")} />
  </>;
}

function SolverFields<T extends CurrentTransportDraft | SpinTransportDraft>({ draft, field }: {
  draft: T;
  field: (key: keyof T) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => void;
}) {
  return <>
    <FormField label="Solver engine" value={draft.solverEngine} onChange={field("solverEngine")} />
    <FormField label="Relative tolerance" value={draft.solverRelativeTolerance} onChange={field("solverRelativeTolerance")} />
    <FormField label="Absolute tolerance" value={draft.solverAbsoluteTolerance} onChange={field("solverAbsoluteTolerance")} />
    <FormField label="Maximum iterations" value={draft.solverMaxIterations} onChange={field("solverMaxIterations")} />
    <FormField label="Physical residual version" value={draft.solverPhysicalResidualVersion} onChange={field("solverPhysicalResidualVersion")} />
    <FormField label="Operator version" value={draft.solverOperatorVersion} onChange={field("solverOperatorVersion")} />
  </>;
}
