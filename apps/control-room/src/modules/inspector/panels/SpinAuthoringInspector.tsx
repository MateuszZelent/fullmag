"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import type {
  SceneCurrentTransport,
  SceneOerstedField,
  SceneSpinTorque,
  TransportValidationRequest,
  TransportValidationResponse,
} from "@/kernel/api/apiTypes";
import {
  authoringWriteOptions,
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  OERSTED_FIELDS_RESOURCE_KEY,
  SPIN_TORQUES_RESOURCE_KEY,
  invalidateSpinAuthoringResources,
  useCurrentTransportsResource,
  useOerstedFieldsResource,
  useSpinTorquesResource,
} from "@/kernel/resources/spinAuthoringResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";
import { isKnownCurrentTransport } from "@/shared/domain/physics/transportRecognition";

import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { PhysicsInspectorOverview } from "./PhysicsInspectorOverview";
import { buildPhysicsInspectorOverviewModel } from "./PhysicsInspectorOverviewModel";
import type { PhysicsInteractionId } from "./PhysicsInteractionPanelModel";
import { reconcileSpinAuthoringDraft } from "./spinAuthoringDraft";
import {
  currentSourceOptions,
  isUnsupportedSpinAuthoringResource,
  torqueCurrentBindingPatch,
  type TorqueCurrentBinding,
} from "./SpinAuthoringInspectorModel";

type Family = "spin_torque" | "oersted_field";
type SpinResource = SceneSpinTorque | SceneOerstedField;

interface SpinAuthoringInitialScope {
  objectId: string;
  regionId?: string | null;
}

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
  landeG: string;
  lambdaAsymmetry: string;
  operatorVersion: string;
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
  formulaVersion: "zhang_li.legacy_fullmag.v0",
  freeLayerThickness: "",
  id: "spin-torque",
  kind: "zhang_li",
  landeG: "",
  lambdaAsymmetry: "1",
  operatorVersion: "",
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
  const commaParts = value.split(",");
  if (commaParts.some((part) => !part.trim())) throw new Error(`${label} requires three finite components.`);
  const parsed = commaParts.flatMap((part) => part.trim().split(/\s+/)).map(Number);
  if (parsed.length !== 3 || parsed.some((entry) => !Number.isFinite(entry))) throw new Error(`${label} requires three finite components.`);
  return parsed;
}

function finite(value: string, label: string): number {
  if (!value.trim()) throw new Error(`${label} is required.`);
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

function torqueDraft(
  value: SceneSpinTorque | null,
  initialTarget?: SpinAuthoringInitialScope | null,
): TorqueDraft {
  const record = object(value);
  if (!value || isUnsupportedSpinAuthoringResource("spin_torque", record)) {
    return {
      ...DEFAULT_TORQUE,
      target: initialTarget
        ? jsonText({
            object_id: initialTarget.objectId,
            ...(initialTarget.regionId ? { region_id: initialTarget.regionId } : {}),
          })
        : DEFAULT_TORQUE.target,
    };
  }
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
    landeG: text(record.lande_g),
    lambdaAsymmetry: text(record.lambda_asymmetry),
    operatorVersion: text(record.operator_version),
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

function oerstedDraft(
  value: SceneOerstedField | null,
  initialSource?: string | null,
): OerstedDraft {
  const record = object(value);
  if (!value || isUnsupportedSpinAuthoringResource("oersted_field", record)) {
    return initialSource
      ? {
          ...DEFAULT_OERSTED,
          id: `oersted:${initialSource}`,
          kind: "oersted_field",
          source: initialSource,
        }
      : { ...DEFAULT_OERSTED };
  }
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
    formula_version: draft.formulaVersion as never,
    schema_version: draft.schemaVersion.trim() || undefined,
    operator_version: draft.operatorVersion.trim() ? draft.operatorVersion as never : undefined,
    target: optionalJson(draft.target) as never,
    current_density: optionalVector(draft.currentDensity, "Current density"),
    current_source: draft.currentSource.trim() ? draft.currentSource : undefined,
    degree: finite(draft.degree, "Degree"),
    beta: finite(draft.beta, "Beta"),
    lande_g: draft.landeG.trim() ? finite(draft.landeG, "Landé g factor") : undefined,
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

export function resolveOerstedCurrentSource(
  currents: readonly SceneCurrentTransport[],
  scope: SpinAuthoringInitialScope | null,
): string | null {
  if (!scope) return null;
  const matches = currents.flatMap((current) => {
    if (!isKnownCurrentTransport(current)) return [];
    const domain = current.domain ?? [];
    const exactDomainMatch = domain.some((region) =>
      region.object_id === scope.objectId
      && (scope.regionId ? region.region_id === scope.regionId : true),
    );
    const legacyObjectMatch = !scope.regionId
      && domain.length === 0
      && current.solve_region === scope.objectId;
    return exactDomainMatch || legacyObjectMatch ? [current.name.trim()] : [];
  }).filter(Boolean);
  return matches.length === 1 ? matches[0] : null;
}

export function SpinAuthoringInspector({ family, initialScope, resourceId, resourceIndex }: {
  family: Extract<PhysicsInteractionId, Family>;
  initialScope?: SpinAuthoringInitialScope | null;
  resourceId?: string | null;
  resourceIndex?: number | null;
}) {
  const kernel = useKernel();
  const { api, commands, resources } = kernel;
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const torques = useSpinTorquesResource({ enabled: family === "spin_torque" });
  const oersted = useOerstedFieldsResource({ enabled: family === "oersted_field" });
  const currents = useCurrentTransportsResource({ enabled: true });
  const active = family === "spin_torque" ? torques : oersted;
  const items = useMemo(() => (active.data?.items ?? []) as SpinResource[], [active.data]);
  const [localSelectedId, setLocalSelectedId] = useState("");
  const requestedId = resourceId ?? localSelectedId;
  const selected = (requestedId ? items.find((item) => identity(item) === requestedId)
    : resourceIndex !== undefined && resourceIndex !== null ? items[resourceIndex] : null) ?? null;
  const selectedId = requestedId || (selected ? identity(selected) : "");
  const readOnly = selected ? isUnsupportedSpinAuthoringResource(family, object(selected)) : false;
  const incomingDraft = family === "spin_torque"
    ? torqueDraft(selected as SceneSpinTorque | null, selected ? null : initialScope)
    : oerstedDraft(
        selected as SceneOerstedField | null,
        selected
          ? null
          : resolveOerstedCurrentSource(currents.data?.items ?? [], initialScope ?? null),
      );
  const keyFor = (localId: string) => JSON.stringify([sessionScopeKey, family,
    resourceId ?? (resourceIndex !== undefined && resourceIndex !== null ? `index:${resourceIndex}` : localId || "new"),
    initialScope?.objectId ?? null, initialScope?.regionId ?? null]);
  const draftKey = keyFor(localSelectedId);
  const [draftState, setDraftState] = useState<{
    key: string; value: TorqueDraft | OerstedDraft; baseline: TorqueDraft | OerstedDraft;
    ackRevision: number | null; conflicts: string[];
  }>({ key: draftKey, value: incomingDraft, baseline: incomingDraft, ackRevision: null, conflicts: [] });
  const [unconfirmedAck, setUnconfirmedAck] = useState<{ key: string; minimumRevision: number } | null>(null);
  const sourceRevision = active.data?.scene_revision;
  const sameDraft = draftState.key === draftKey;
  const olderThanAck = sameDraft && draftState.ackRevision !== null && (sourceRevision ?? -1) < draftState.ackRevision;
  const legacyTargetChanged = sameDraft && !requestedId && resourceIndex !== undefined && resourceIndex !== null
    && selected !== null && draftState.baseline.id !== incomingDraft.id;
  const targetUnavailable = Boolean(legacyTargetChanged || (selectedId || resourceIndex !== undefined && resourceIndex !== null)
    && !selected && active.status === "ready" && !olderThanAck);
  const baseDraft = sameDraft && (olderThanAck || targetUnavailable) ? draftState.baseline : incomingDraft;
  const reconciled = sameDraft ? reconcileSpinAuthoringDraft(baseDraft, draftState.value, draftState.baseline)
    : { draft: baseDraft, conflicts: [] };
  const draft = reconciled.draft;
  const conflicts = [...new Set([...(sameDraft ? draftState.conflicts : []), ...reconciled.conflicts])];
  const conflictReason = conflicts.length ? `Conflicting fields: ${conflicts.join(", ")}. Revert to the current server definition and review before applying.` : undefined;
  const awaitingAckRefresh = unconfirmedAck?.key === draftKey && (sourceRevision ?? -1) < unconfirmedAck.minimumRevision;
  const sourceCurrent = active.status === "ready" && !active.error && !active.refreshError && sourceRevision !== undefined && !olderThanAck && !awaitingAckRefresh;
  const activeDraftKey = useRef(draftKey);
  const targetGeneration = useRef(0);
  const latestSource = useRef({ key: draftKey, revision: sourceRevision });
  const mounted = useRef(true);
  useLayoutEffect(() => {
    if (activeDraftKey.current !== draftKey) targetGeneration.current++;
    activeDraftKey.current = draftKey;
    latestSource.current = { key: draftKey, revision: latestSource.current.key === draftKey
      ? Math.max(latestSource.current.revision ?? -1, sourceRevision ?? -1) : sourceRevision };
  }, [draftKey, sourceRevision]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [feedbackState, setFeedbackState] = useState<{ key: string; kind: "error" | "success" | "warning"; message: string } | null>(null);
  const feedback = feedbackState?.key === draftKey ? feedbackState : null;
  const setFeedback = (value: { kind: "error" | "success" | "warning"; message: string } | null) => setFeedbackState(value ? { ...value, key: draftKey } : null);
  const [pendingOperation, setPendingOperation] = useState<{
    id: number;
    sessionScopeKey: string;
    draftKey: string;
    action: "save" | "delete";
  } | null>(null);
  const nextPendingOperationId = useRef(0);
  const pending = pendingOperation?.sessionScopeKey === sessionScopeKey && pendingOperation.draftKey === draftKey;
  const inFlightKey = useRef<string | null>(null);
  const validationKey = `${draftKey}:${sourceRevision ?? "none"}:${JSON.stringify(draft)}`;
  const [validationState, setValidationState] = useState<{ key: string; response: TransportValidationResponse | null }>({ key: "", response: null });
  const validation = validationState.key === validationKey ? validationState.response : null;
  const capability = useSessionStatusSelector((status) => status.data?.capabilities.transport_authoring?.m1_one_way_steady ?? null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseDraft) || conflicts.length > 0;
  const valid = Boolean(
    !readOnly && !targetUnavailable && conflicts.length === 0 && sourceCurrent &&
      capability?.authoring_allowed &&
      validation?.semantic.valid === true &&
      validation?.execution.authoring_allowed === true,
  );
  const lockReason = readOnly
    ? "Unknown authoring records are read-only."
    : !sessionScopeKey
      ? "Session identity is not ready."
    : !capability?.authoring_allowed
        ? capability?.reason ?? "Authoring capability is unavailable."
        : undefined;

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

  const captureMutationContext = () => captureAuthoringMutationFence(
    createCommandContext("inspector", kernel, { sessionScopeKey }),
  );
  const isCurrentSession = () => Boolean(
    sessionScopeKey && commands?.getSessionScopeKey?.() === sessionScopeKey,
  );

  useEffect(() => {
    if (!sessionScopeKey || readOnly || targetUnavailable || conflicts.length || !sourceCurrent) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      try {
        void api.model.validateTransport(validationRequest(), {
          sessionScopeKey,
          signal: controller.signal,
        }).then((response) => {
          if (!controller.signal.aborted && isCurrentSession() && activeDraftKey.current === draftKey && mounted.current) {
            setValidationState({ key: validationKey, response });
          }
        }).catch(() => {
          if (!controller.signal.aborted && isCurrentSession() && activeDraftKey.current === draftKey && mounted.current) {
            setValidationState({ key: validationKey, response: null });
          }
        });
      } catch {
        if (!controller.signal.aborted && isCurrentSession() && activeDraftKey.current === draftKey && mounted.current) {
          setValidationState({ key: validationKey, response: null });
        }
      }
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  // Serialized draft is the validation dependency by design.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, commands, family, readOnly, selectedId, sessionScopeKey, sourceCurrent, targetUnavailable, conflictReason, validationKey]);

  const patch = (value: Partial<TorqueDraft> | Partial<OerstedDraft>) => {
    if (readOnly || targetUnavailable || pending && pendingOperation?.action === "delete" || "id" in value && (pending || inFlightKey.current === draftKey)) return;
    setDraftState({ key: draftKey, value: Object.assign({}, draft, value) as TorqueDraft | OerstedDraft,
      baseline: baseDraft, ackRevision: sameDraft ? draftState.ackRevision : null, conflicts });
  };

  async function save(): Promise<boolean> {
    if (!sessionScopeKey || pending || inFlightKey.current === draftKey || !valid || Boolean(selectedId) && !dirty) return false;
    const submittedDraft = draft;
    const mutationContext = captureMutationContext();
    const generation = targetGeneration.current;
    const isCurrentDraft = () => mounted.current && activeDraftKey.current === draftKey && targetGeneration.current === generation && mutationContext.isCurrentSessionScope?.() === true;
    const operationId = ++nextPendingOperationId.current;
    inFlightKey.current = draftKey;
    setDraftState({ key: draftKey, value: submittedDraft, baseline: baseDraft,
      ackRevision: sameDraft ? draftState.ackRevision : null, conflicts: [] });
    setPendingOperation({ id: operationId, sessionScopeKey, draftKey, action: "save" });
    setFeedback(null);
    try {
      if (!capability?.authoring_allowed) throw new Error(capability?.reason ?? "Authoring capability is unavailable.");
      const checked = await api.model.validateTransport(validationRequest(), { sessionScopeKey });
      if (!isCurrentDraft()) return false;
      setValidationState({ key: validationKey, response: checked });
      if (!checked.semantic.valid || !checked.execution.authoring_allowed) throw new Error(checked.semantic.issues[0]?.message ?? checked.execution.reason ?? "Candidate is not authoring-ready.");
      const resource = resourceFromDraft();
      const base_revision = active.data?.scene_revision;
      if (base_revision === undefined) throw new Error("Scene revision is unavailable.");
      const commit = await runAuthoringMutationWithHistory(
        mutationContext,
        `${selectedId ? "Replace" : "Create"} ${family}${selectedId ? ` ${selectedId}` : ""}`,
        async ({ baseRevision }) => {
          if (!isCurrentDraft()) throw new Error("Authoring target changed before commit.");
          const committedRevision = baseRevision ?? base_revision;
          if (committedRevision !== base_revision) throw new Error("Scene revision changed before authoring commit. Refresh and reconcile the draft.");
          const requestOptions = authoringWriteOptions(null, mutationContext.sessionScopeKey);
          if (!requestOptions?.sessionScopeKey) throw new Error("Session identity is not ready.");
          if (family === "spin_torque") {
            const request = { base_revision: committedRevision, resource: resource as SceneSpinTorque };
            return selectedId
              ? api.model.replaceSpinTorque(selectedId, request, requestOptions)
              : api.model.createSpinTorque(request, requestOptions);
          }
          const request = { base_revision: committedRevision, resource: resource as SceneOerstedField };
          return selectedId
            ? api.model.replaceOerstedField(selectedId, request, requestOptions)
            : api.model.createOerstedField(request, requestOptions);
        },
      );
      if (mutationContext.isCurrentSessionScope?.() !== true) return false;
      invalidateSpinAuthoringResources(resources, commit, [family === "spin_torque" ? SPIN_TORQUES_RESOURCE_KEY : OERSTED_FIELDS_RESOURCE_KEY]);
      if (!isCurrentDraft()) return false;
      if (!Number.isSafeInteger(commit.scene_revision) || commit.scene_revision <= (base_revision ?? -1)
        || !commit.resource || identity(commit.resource) !== submittedDraft.id || isUnsupportedSpinAuthoringResource(family, object(commit.resource))) {
        setUnconfirmedAck({ key: draftKey, minimumRevision: Number.isSafeInteger(commit.scene_revision) && commit.scene_revision > base_revision ? commit.scene_revision : base_revision + 1 });
        active.refetch();
        throw new Error("Commit acknowledged, but its returned authoring definition is unconfirmed. Refresh before retrying.");
      }
      if (latestSource.current.key === draftKey && (latestSource.current.revision ?? -1) > commit.scene_revision) {
        setFeedback({ kind: "warning", message: "Commit acknowledged, but a newer server revision is already loaded. Your edits are preserved; review before applying again." });
        return false;
      }
      const acknowledged = family === "spin_torque" ? torqueDraft(commit.resource as SceneSpinTorque, null)
        : oerstedDraft(commit.resource as SceneOerstedField, null);
      setUnconfirmedAck(null);
      const acknowledgedKey = !selectedId ? keyFor(submittedDraft.id) : draftKey;
      setDraftState((current) => {
        if (current.key !== draftKey) return current;
        const next = reconcileSpinAuthoringDraft(acknowledged, current.value, submittedDraft);
        return { key: acknowledgedKey, value: next.draft, baseline: acknowledged, ackRevision: commit.scene_revision,
          conflicts: [...new Set([...current.conflicts, ...next.conflicts])] };
      });
      if (!selectedId) setLocalSelectedId(submittedDraft.id);
      setFeedbackState({ key: acknowledgedKey, kind: "success", message: "Authoring resource committed." });
      return true;
    } catch (error) {
      if (!isCurrentDraft()) return false;
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (inFlightKey.current === draftKey) inFlightKey.current = null;
      if (mounted.current) setPendingOperation((current) => current?.id === operationId ? null : current);
    }
  }

  function resetDraft(): void {
    if (pending || inFlightKey.current === draftKey) return;
    setDraftState({ key: draftKey, value: baseDraft, baseline: baseDraft,
      ackRevision: olderThanAck ? draftState.ackRevision : null, conflicts: [] });
    setFeedback(null);
  }

  async function remove(): Promise<void> {
    if (!selectedId || active.data?.scene_revision === undefined || readOnly || !sessionScopeKey || pending || inFlightKey.current === draftKey || !valid || dirty) return;
    const submittedRevision = active.data.scene_revision;
    const mutationContext = captureMutationContext();
    const generation = targetGeneration.current;
    const isCurrentDraft = () => mounted.current && activeDraftKey.current === draftKey && targetGeneration.current === generation && mutationContext.isCurrentSessionScope?.() === true;
    const operationId = ++nextPendingOperationId.current;
    inFlightKey.current = draftKey;
    setPendingOperation({ id: operationId, sessionScopeKey, draftKey, action: "delete" });
    try {
      if (!capability?.authoring_allowed || validation?.execution.authoring_allowed !== true) throw new Error(capability?.reason ?? validation?.execution.reason ?? "Latest validation does not permit mutation.");
      const commit = await runAuthoringMutationWithHistory(
        mutationContext,
        `Delete ${family} ${selectedId}`,
        async ({ baseRevision }) => {
          if (!isCurrentDraft()) throw new Error("Authoring target changed before delete.");
          if ((baseRevision ?? submittedRevision) !== submittedRevision) throw new Error("Scene revision changed before authoring delete. Refresh and reconcile the draft.");
          const request = {
            base_revision: submittedRevision,
          };
          const requestOptions = authoringWriteOptions(null, mutationContext.sessionScopeKey);
          if (!requestOptions?.sessionScopeKey) throw new Error("Session identity is not ready.");
          return family === "spin_torque"
            ? api.model.deleteSpinTorque(selectedId, request, requestOptions)
            : api.model.deleteOerstedField(selectedId, request, requestOptions);
        },
      );
      if (mutationContext.isCurrentSessionScope?.() !== true) return;
      invalidateSpinAuthoringResources(resources, commit, [family === "spin_torque" ? SPIN_TORQUES_RESOURCE_KEY : OERSTED_FIELDS_RESOURCE_KEY]);
      if (!isCurrentDraft()) return;
      setLocalSelectedId("");
      setFeedbackState({ key: resourceId === undefined && resourceIndex === undefined ? keyFor("") : draftKey, kind: "success", message: "Authoring resource deleted." });
    } catch (error) {
      if (!isCurrentDraft()) return;
      setFeedback({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (inFlightKey.current === draftKey) inFlightKey.current = null;
      if (mounted.current) setPendingOperation((current) => current?.id === operationId ? null : current);
    }
  }

  useRegisterInspectorEditSession(
    "staged",
    pending,
    dirty,
    valid,
    lockReason,
    save,
    resetDraft,
    { historyMode: "mutation-owned", applyBlockReason: conflictReason ?? (targetUnavailable ? "Selected authoring target is unavailable." : !sourceCurrent ? "Confirm the current authoring source before applying." : undefined) },
  );

  return <div className="fm-inspector-panel"><InspectorGroup title={family === "spin_torque" ? "Transport torque" : "Oersted field"}>
    {resourceId === undefined && resourceIndex === undefined ? <>
      <FormField label="Resource" type="select" value={localSelectedId} disabled={dirty || pending} onChange={(event) => {
        const id = event.target.value;
        if (!dirty && !pending && inFlightKey.current !== draftKey && (id === "" || items.some((item) => identity(item) === id))) setLocalSelectedId(id);
      }}><option value="">New resource</option>
        {localSelectedId && !items.some((item) => identity(item) === localSelectedId) ? <option value={localSelectedId} disabled>{localSelectedId} (unconfirmed; preserved)</option> : null}
        {items.map((item, index) => <option key={`${identity(item)}:${index}`} value={identity(item)}>{identity(item) || `Unknown ${index + 1}`}</option>)}
      </FormField>
      {dirty || pending ? <p className="fm-help-text" role="status">Apply or Revert changes before switching resources.</p> : null}
    </> : null}
    <fieldset className="m-0 min-w-0 border-0 p-0" disabled={targetUnavailable || pending && pendingOperation?.action === "delete"}>
    {readOnly && selected ? <><FeedbackBanner kind="warning" message="Unknown authoring record is preserved losslessly and is read-only." /><FormField label="Opaque payload" type="textarea" rows={20} readOnly value={JSON.stringify(selected, null, 2)} /></> : family === "spin_torque" ? <TorqueFields currentTransports={currents.data?.items ?? []} draft={draft as TorqueDraft} identityReadOnly={Boolean(selectedId) || pending} patch={patch} /> : <OerstedFields currentTransports={currents.data?.items ?? []} draft={draft as OerstedDraft} identityReadOnly={Boolean(selectedId) || pending} patch={patch} />}
    </fieldset>
    {!readOnly ? <div className="fm-help-text"><div>Qualification: {validation?.execution.qualification ?? capability?.status ?? "checking"}</div><div>{validation?.execution.reason ?? capability?.reason ?? "Capability unavailable."}</div></div> : null}
    {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    {conflictReason ? <FeedbackBanner kind="error" message={conflictReason} /> : null}
    {targetUnavailable ? <FeedbackBanner kind="error" message="Selected authoring target is unavailable or its positional identity changed. Your draft is preserved; select the exact resource again." /> : null}
    {!sourceCurrent ? <FeedbackBanner kind="warning" message="Current authoring source is unconfirmed. Your edits are preserved." /> : null}
    {active.error || active.refreshError ? <FeedbackBanner kind="error" message={(active.error ?? active.refreshError)?.message ?? "Authoring source refresh failed."} /> : null}
    <Button type="button" onClick={() => { active.refetch(); currents.refetch(); }}>Refresh authoring resources</Button>
    {!readOnly ? <Button disabled={pending || Boolean(selectedId) && !dirty || !valid} onClick={() => void save()}>{pending ? "Committing…" : selectedId ? "Replace" : "Create"}</Button> : null}
    <Button disabled={pending || !dirty} onClick={resetDraft}>Revert</Button>
    {selected && !readOnly ? <Button disabled={pending || dirty || !valid} variant="danger" onClick={() => void remove()}>Delete</Button> : null}
  </InspectorGroup></div>;
}

function TorqueFields({ currentTransports, draft, identityReadOnly, patch }: { currentTransports: readonly SceneCurrentTransport[]; draft: TorqueDraft; identityReadOnly: boolean; patch: (value: Partial<TorqueDraft> | Partial<OerstedDraft>) => void }) {
  const field = (key: keyof TorqueDraft) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => patch({ [key]: event.target.value });
  const currentBinding: TorqueCurrentBinding = draft.currentSource.trim()
    ? "current_transport"
    : "prescribed_density";
  const sourceOptions = currentSourceOptions(currentTransports, draft.currentSource);
  return <>
    <FormField label="Torque id" readOnly={identityReadOnly} value={draft.id} onChange={field("id")} />
    <FormField label="Torque model" type="select" value={draft.kind} onChange={(event) => patch(torqueModelPatch(draft, event.target.value as TorqueDraft["kind"]))}><option value="zhang_li">Zhang-Li</option><option value="slonczewski">Slonczewski</option><option value="prescribed_sot">Prescribed SOT</option></FormField>
    {draft.kind !== "prescribed_sot" ? <>
    <FormField label="Current binding" type="select" value={currentBinding} onChange={(event) => patch(torqueCurrentBindingPatch(draft, event.target.value as TorqueCurrentBinding, sourceOptions[0]?.value))}><option value="prescribed_density">Prescribed density</option><option value="current_transport">Current transport</option></FormField>
      {currentBinding === "prescribed_density"
        ? <FormField label="Current density" unit="A/m²" value={draft.currentDensity} onChange={field("currentDensity")} />
        : <FormField label="Current source" type="select" value={draft.currentSource} onChange={field("currentSource")}><option value="">Select current transport</option>{sourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</FormField>}
      <FormField label="Polarization degree" value={draft.degree} onChange={field("degree")} />
    </> : null}
    {draft.kind === "zhang_li" ? <>
      <FormField label="Non-adiabaticity beta" value={draft.beta} onChange={field("beta")} />
      <FormField label="Formula version" type="select" value={draft.formulaVersion} onChange={field("formulaVersion")}><option value="zhang_li.legacy_fullmag.v0">Legacy Fullmag</option><option value="zhang_li.fullmag.v1">Fullmag v1</option><option value="zhang_li.mumax3.v1">MuMax3-compatible v1</option></FormField>
      <FormField label="Operator version" type="select" value={draft.operatorVersion} onChange={field("operatorVersion")}><option value="">Legacy/default</option><option value="zl_central_reference_v1">Central reference v1</option><option value="zl_mumax3_central_v1">MuMax3 central v1</option></FormField>
      <FormField label="Landé g factor" value={draft.landeG} onChange={field("landeG")} />
      <FormField label="Target region" type="textarea" value={draft.target} onChange={field("target")} />
      <FormField label="Schema version" value={draft.schemaVersion} onChange={field("schemaVersion")} />
    </> : null}
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

export function torqueModelPatch(draft: TorqueDraft, kind: TorqueDraft["kind"]): Partial<TorqueDraft> {
  if (kind === "zhang_li") {
    return { kind, formulaVersion: "zhang_li.legacy_fullmag.v0", schemaVersion: "", operatorVersion: "", landeG: "" };
  }
  if (kind === "slonczewski") {
    return { kind, formulaVersion: "slonczewski.fullmag.v2", schemaVersion: "" };
  }
  return {
    kind,
    formulaVersion: "prescribed_sot.fullmag.v1",
    schemaVersion: "prescribed_sot.v1",
    freeLayerThickness: draft.freeLayerThickness || "1e-9",
  };
}

function OerstedFields({ currentTransports, draft, identityReadOnly, patch }: { currentTransports: readonly SceneCurrentTransport[]; draft: OerstedDraft; identityReadOnly: boolean; patch: (value: Partial<TorqueDraft> | Partial<OerstedDraft>) => void }) {
  const field = (key: keyof OerstedDraft) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => patch({ [key]: event.target.value });
  const sourceOptions = currentSourceOptions(currentTransports, draft.source);
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
      <FormField label="Current solution source" type="select" value={draft.source} onChange={field("source")}><option value="">Select current solution</option>{sourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</FormField>
      <FormField label="Field model" value={draft.model} readOnly />
    </>}
  </>;
}

export function SpinTorqueInspectorPanel({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "spin-torque" ? selection.ref : null;
  const selectedRegionId = selection.ref?.type === "scene-object"
    ? selection.ref.regionId ?? null
    : null;
  const initialScope = ref === null && selection.objectId
    ? { objectId: selection.objectId, regionId: selectedRegionId }
    : null;
  return (
    <PhysicsInspectorOverview
      model={buildPhysicsInspectorOverviewModel({
        family: "spin_torque",
        scope: {
          kind: selectedRegionId ? "region" : selection.objectId ? "object" : "global",
          objectId: selection.objectId,
          regionId: selectedRegionId,
          stableRef: selectedRegionId && selection.objectId
            ? `region:${selection.objectId}:${selectedRegionId}`
            : selection.objectId
              ? `object:${selection.objectId}`
              : "global:physics",
        },
        source: {
          id: ref?.spinTorqueId ?? "new",
          kind: "spin_torque",
          status: "active",
        },
        status: "active",
      })}
      primary={<SpinAuthoringInspector family="spin_torque" initialScope={initialScope} resourceId={ref?.spinTorqueId} resourceIndex={ref?.spinTorqueIndex} />}
    />
  );
}

export function OerstedFieldInspectorPanel({ selection }: InspectorPanelProps) {
  const ref = selection.ref?.type === "oersted-field" ? selection.ref : null;
  const selectedRegionId = selection.ref?.type === "scene-object"
    ? selection.ref.regionId ?? null
    : null;
  const initialScope = ref === null && selection.objectId
    ? { objectId: selection.objectId, regionId: selectedRegionId }
    : null;
  return (
    <PhysicsInspectorOverview
      model={buildPhysicsInspectorOverviewModel({
        family: "oersted_field",
        scope: {
          kind: "global",
          stableRef: "global:physics",
        },
        source: {
          id: ref?.oerstedFieldId ?? "new",
          kind: "oersted_field",
          status: "active",
        },
        status: "active",
      })}
      primary={<SpinAuthoringInspector family="oersted_field" initialScope={initialScope} resourceId={ref?.oerstedFieldId} resourceIndex={ref?.oerstedFieldIndex} />}
    />
  );
}
