"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { runFdmGridRefreshOperation } from "@/kernel/authoring/geometryLifecycleCommandContributions";
import { parseQuantityInput } from "@/kernel/authoring/object-edit/quantityInput";
import { useKernel } from "@/kernel/KernelContext";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";
import {
  sessionRequestScopeKey,
} from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  SCENE_RESOURCE_KEY,
  MESH_UNIVERSE_POLICY_RESOURCE_KEY,
  useGeometryDiagnosticsResource,
  useSceneResource,
  useUniverseMeshPolicyResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { publishCommittedMeshPolicyResource } from "@/kernel/resources/meshPolicyResourceCache";
import { Button } from "@/shared/ui/Button";

import {
  useInspectorEditSession,
  useRegisterInspectorEditSession,
} from "../../InspectorEditSession";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import {
  AirboxFieldRow as FieldRow,
  airboxEffectiveLengthUnit,
  boundedDisplayText,
} from "./airboxDisplay";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { QuantityUnitSelect } from "../../primitives/QuantityUnitSelect";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
  type InspectorDraftState,
} from "../inspectorDraftState";
import {
  AIRBOX_GRADING_MODES,
  updateAirboxLengthUnit,
  airboxMeshPolicyDraftDirty,
  airboxMeshPolicyJsonError,
  updateAirboxMeshPolicyDraft,
  buildAirboxMeshPolicyReplaceRequest,
  defaultUniverseMeshPolicyResource,
  draftFromEffectiveUniverseMeshPolicyResource,
  draftFromUniverseMeshPolicyResource,
  draftIdentityKeyForUniverseMeshPolicyResource,
  draftKeyForUniverseMeshPolicyResource,
  type AirboxMeshPolicyDraft,
  type AirboxLengthPolicyField,
  type AirboxLengthUnit,
  type AirboxMeshPolicyLane,
} from "./airboxMeshPolicyDraft";
import type {
  GeometryDiagnosticsResource,
  MeshUniverseConfigReplaceRequest,
  MeshUniverseConfigResource,
} from "@/kernel/api/apiTypes";

type Feedback = { kind: "error" | "success" | "warning"; message: string } | null;

export async function submitAirboxPolicyDraft(
  draft: AirboxMeshPolicyDraft,
  replace: (
    request: MeshUniverseConfigReplaceRequest,
    options?: { sessionScopeKey?: string },
  ) => Promise<MeshUniverseConfigResource>,
  options: { lane?: AirboxMeshPolicyLane; sessionScopeKey?: string | null } = {},
): Promise<
  | { error: string; kind: "error" }
  | { kind: "noop" }
  | { kind: "submitted"; resource: MeshUniverseConfigResource }
> {
  const result = buildAirboxMeshPolicyReplaceRequest(draft, options);
  if ("error" in result) return { error: result.error, kind: "error" };
  if (result.request === null) return { kind: "noop" } as const;
  const requestOptions = options.sessionScopeKey
    ? { sessionScopeKey: options.sessionScopeKey }
    : undefined;
  return { kind: "submitted", resource: await replace(result.request, requestOptions) } as const;
}

function GeometryBoundsDiagnosticNotice({
  diagnostics,
  error,
  onAdjustBounds,
  onOpenDiagnostics,
  onSelectObject,
  sceneRevision,
  status,
}: {
  diagnostics: GeometryDiagnosticsResource | null;
  error?: unknown;
  onAdjustBounds: () => void;
  onOpenDiagnostics: () => void;
  onSelectObject: (objectId: string) => void;
  sceneRevision: number | null;
  status: string;
}) {
  const outside = diagnostics?.diagnostics.filter(
    (diagnostic) => diagnostic.code === "GEOMETRY_OBJECT_OUTSIDE_UNIVERSE",
  ) ?? [];
  const stale = Boolean(
    diagnostics &&
      sceneRevision !== null &&
      diagnostics.scene_revision !== sceneRevision,
  );
  if (error || status === "error") {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" role="status">
        <p>Backend geometry diagnostics could not be loaded.</p>
        <p>{boundedDisplayText(error instanceof Error ? error.message : String(error ?? "No error details published."))}</p>
        <Button size="sm" type="button" variant="secondary" onClick={onOpenDiagnostics}>Open diagnostics</Button>
      </div>
    );
  }
  if (!diagnostics) {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" role="status">
        <p>{status === "loading" ? "Checking backend geometry diagnostics for manual bounds." : "Geometry diagnostics are not available for this session."}</p>
        <Button size="sm" type="button" variant="secondary" onClick={onOpenDiagnostics}>Open diagnostics</Button>
      </div>
    );
  }
  if (stale) {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" role="status">
        <p>Backend geometry diagnostics are for scene revision {diagnostics.scene_revision}; current scene revision is {sceneRevision}.</p>
        <Button size="sm" type="button" variant="secondary" onClick={onOpenDiagnostics}>Open current diagnostics</Button>
      </div>
    );
  }
  if (outside.length === 0) {
    return (
      <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" role="status">
        <p>The backend has not published GEOMETRY_OBJECT_OUTSIDE_UNIVERSE for scene revision {diagnostics.scene_revision}.</p>
        <Button size="sm" type="button" variant="secondary" onClick={onOpenDiagnostics}>Open diagnostics</Button>
      </div>
    );
  }
  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" role="status">
      {outside.map((diagnostic) => (
        <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" key={diagnostic.id}>
          <p>{diagnostic.message}</p>
          <FieldRow label="Backend diagnostic" value={diagnostic.code} />
          <FieldRow label="Severity" value={diagnostic.severity} />
          <FieldRow label="Backend blocks" value={diagnostic.blocks?.join(", ") ?? "not published"} />
          {diagnostic.geometry_path ? <FieldRow label="Geometry path" value={diagnostic.geometry_path} /> : null}
          {diagnostic.object_id ? (
            <Button size="sm" type="button" variant="secondary" onClick={() => onSelectObject(diagnostic.object_id!)}>
              Select object to adjust placement
            </Button>
          ) : null}
        </div>
      ))}
      <div className="fm-inspector-toolbar">
        <Button size="sm" type="button" variant="primary" onClick={onAdjustBounds}>Adjust manual bounds</Button>
        <Button size="sm" type="button" variant="secondary" onClick={onOpenDiagnostics}>Open diagnostics</Button>
      </div>
    </div>
  );
}
type AirboxMeshPolicyTextKey = Exclude<
  keyof AirboxMeshPolicyDraft,
  | "airboxGradingAuthored"
  | "authoredConfigPresent"
  | "syncedConfigText"
  | "configSynchronized"
  | "quantityUnits"
>;

const NUMBER_FIELDS: readonly {
  key: AirboxMeshPolicyTextKey;
  label: string;
  unit?: string;
}[] = [
  { key: "airboxHmax", label: "Maximum element size", unit: "m" },
  { key: "airboxHmin", label: "Minimum element size", unit: "m" },
  { key: "airboxGrowthRate", label: "Maximum element growth rate" },
  { key: "curvatureFactor", label: "Curvature factor" },
  { key: "narrowRegionResolution", label: "Resolution of narrow regions" },
];

const VECTOR_FIELDS: readonly {
  key: AirboxLengthPolicyField;
  label: string;
}[] = [
  { key: "paddingX", label: "Padding X" },
  { key: "paddingY", label: "Padding Y" },
  { key: "paddingZ", label: "Padding Z" },
  { key: "airboxSizeX", label: "Size X" },
  { key: "airboxSizeY", label: "Size Y" },
  { key: "airboxSizeZ", label: "Size Z" },
  { key: "airboxCenterX", label: "Center X" },
  { key: "airboxCenterY", label: "Center Y" },
  { key: "airboxCenterZ", label: "Center Z" },
];

const EFFECTIVE_FIELDS = [
  ["mode", "Effective domain mode"],
  ["airbox_hmax", "Effective maximum element size"],
  ["airbox_hmin", "Effective minimum element size"],
  ["airbox_growth_rate", "Effective growth rate"],
  ["airbox_grading", "Effective grading"],
  ["padding", "Effective padding"],
  ["size", "Effective size"],
  ["center", "Effective center"],
] as const;

const FDM_EFFECTIVE_FIELDS = EFFECTIVE_FIELDS.filter(([key]) =>
  ["mode", "padding", "size", "center"].includes(key),
);

const displayEffectiveValue = (value: unknown) =>
  Array.isArray(value) ? value.join(", ") : value == null ? "not published" : String(value);

export type AirboxMeshParametersLane = "fem" | "fdm";

export function AirboxMeshParametersPanel({
  lane = "fem",
  runtimeLane = null,
  selection,
}: InspectorPanelProps & {
  lane?: AirboxMeshParametersLane;
  runtimeLane?: AirboxMeshParametersLane | null;
}) {
  void selection;
  const isFdm = lane === "fdm";
  const kernel = useKernel();
  const { api, commands, resources } = kernel;
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const policy = useUniverseMeshPolicyResource();
  const resource = policy.data ?? defaultUniverseMeshPolicyResource();
  const baseDraft = useMemo(
    () => draftFromUniverseMeshPolicyResource(resource),
    [resource],
  );
  const baseKey = `${sessionScopeKey ?? "no-session"}:${draftKeyForUniverseMeshPolicyResource(resource)}`;
  const identityKey = draftIdentityKeyForUniverseMeshPolicyResource();
  const [draftState, setDraftState] = useState<
    InspectorDraftState<AirboxMeshPolicyDraft>
  >(() =>
    initialInspectorDraftState({
      baseDraft,
      baseKey,
      identityKey,
    }),
  );
  const [feedbackState, setFeedbackState] = useState<{
    sessionScopeKey: string | null;
    value: Feedback;
  } | null>(null);
  const feedback = feedbackState?.sessionScopeKey === sessionScopeKey
    ? feedbackState.value
    : null;
  const setFeedback = useCallback(
    (value: Feedback) => setFeedbackState({ sessionScopeKey, value }),
    [sessionScopeKey],
  );
  const [pendingOperation, setPendingOperation] = useState<{
    id: number;
    identityKey: string;
    sessionScopeKey: string;
  } | null>(null);
  const nextPendingOperationId = useRef(0);
  const silentApplyInFlight = useRef(false);
  const pending = pendingOperation?.sessionScopeKey === sessionScopeKey &&
    pendingOperation.identityKey === identityKey;
  const [buildPendingOperation, setBuildPendingOperation] = useState<{
    id: number;
    identityKey: string;
    sessionScopeKey: string;
  } | null>(null);
  const nextBuildOperationId = useRef(0);
  const buildInFlight = useRef<{ id: number; sessionScopeKey: string } | null>(null);
  const buildPending = buildPendingOperation?.sessionScopeKey === sessionScopeKey &&
    buildPendingOperation.identityKey === identityKey;
  const { dirty, draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey,
    identityKey,
    isDirty: airboxMeshPolicyDraftDirty,
    state: draftState,
  });
  const commandContext = useMemo(
    () =>
      createCommandContext("inspector", kernel, {
        sessionScopeKey,
        sourceDetail: "airbox-mesh-parameters",
        input: { origin: "airbox" },
      }),
    [kernel, sessionScopeKey],
  );
  const inspectorEditSession = useInspectorEditSession();
  const effectiveMode = draft.airboxMode.trim() || "auto";
  const invalidMode = effectiveMode !== "auto" && effectiveMode !== "manual";
  const manualPolicy = effectiveMode === "manual";
  const geometryDiagnostics = useGeometryDiagnosticsResource({ enabled: manualPolicy });
  const scene = useSceneResource({ enabled: manualPolicy });

  const updateDraft = (patch: Partial<AirboxMeshPolicyDraft>) =>
    setDraftState(
      updateInspectorDraftState({
        baseDraft,
        baseKey,
        currentDraft: draft,
        identityKey,
        isDirty: airboxMeshPolicyDraftDirty,
        patch: updateAirboxMeshPolicyDraft(draft, patch, { lane }),
      }),
    );

  const updateLengthUnit = (
    field: AirboxLengthPolicyField,
    unit: AirboxLengthUnit,
  ) => {
    const nextDraft = updateAirboxLengthUnit(draft, field, unit, { lane });
    setDraftState(
      updateInspectorDraftState({
        baseDraft,
        baseKey,
        currentDraft: draft,
        identityKey,
        isDirty: airboxMeshPolicyDraftDirty,
        patch: nextDraft,
      }),
    );
  };

  const lengthUnitControl = (
    field: AirboxLengthPolicyField,
    label: string,
  ) => (
    <QuantityUnitSelect
      input={parseQuantityInput(
        draft[field],
        "length",
        draft.quantityUnits?.[field] ?? "m",
      )}
      label={label}
      onChange={(unit) => updateLengthUnit(field, unit as AirboxLengthUnit)}
    />
  );

  useEffect(() => {
    const offRestore = kernel.bus.on("mesh:build-history-restore-requested", (event) => {
      if (!event.meshTarget || !/^(study_domain|shared_domain|universe|airbox)$/.test(event.meshTarget)) {
        return;
      }
      if (!Object.hasOwn(event.snapshot, "universe")) return;
      const snapshotValue = event.snapshot.universe;
      const restoredConfig = snapshotValue === null
        ? null
        : snapshotValue && typeof snapshotValue === "object" && !Array.isArray(snapshotValue)
          ? snapshotValue
          : undefined;
      if (restoredConfig === undefined) return;
      const restored = draftFromUniverseMeshPolicyResource({
        ...resource,
        config: restoredConfig as MeshUniverseConfigResource["config"],
      });
      setDraftState({
        baseKey,
        dirty: airboxMeshPolicyDraftDirty(restored, baseDraft),
        draft: restored,
        identityKey,
      });
      setFeedback({
        kind: "success",
        message: `Build ${event.buildId ?? event.entryId} restored to the Airbox draft. Apply the policy before building.`,
      });
    });
    if (policy.status === "ready") kernel.bus.emit("mesh:build-history-editor-ready", { target: "universe" });
    return offRestore;
  }, [baseDraft, baseKey, identityKey, kernel.bus, policy.status, resource, setFeedback]);

  const applyPolicy = async ({ silent = false } = {}) => {
    const operationSessionScopeKey = sessionScopeKey;
    const operationContext = commandContext;
    const isCurrentOperation = () => Boolean(
      operationSessionScopeKey &&
      operationContext.sessionScopeKey === operationSessionScopeKey &&
      operationContext.isCurrentSessionScope?.() === true,
    );
    if (!operationSessionScopeKey || !isCurrentOperation()) {
      if (!silent) setFeedback({ kind: "error", message: "An active session is required to save the Airbox policy." });
      return false;
    }
    const operationId = ++nextPendingOperationId.current;
    setPendingOperation({
      id: operationId,
      identityKey,
      sessionScopeKey: operationSessionScopeKey,
    });
    try {
      const submission = await submitAirboxPolicyDraft(
        draft,
        (request, requestOptions) => api.meshing.replaceUniversePolicy(request, requestOptions),
        { lane, sessionScopeKey: operationSessionScopeKey },
      );
      if (!isCurrentOperation()) return false;
      if (submission.kind === "error") {
        setFeedback({ kind: "error", message: submission.error });
        return false;
      }
      if (submission.kind === "noop") {
        if (!silent && !silentApplyInFlight.current) setFeedback({ kind: "success", message: "No authored Airbox policy changes to apply." });
        return true;
      }
      const next = submission.resource;
      publishCommittedMeshPolicyResource?.(
        resources,
        MESH_UNIVERSE_POLICY_RESOURCE_KEY,
        operationSessionScopeKey,
        next,
      );
      resources.invalidate(MESH_UNIVERSE_POLICY_RESOURCE_KEY, next.revision);
      resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, next.revision);
      resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, next.revision);
      let fdmReplanMessage: Feedback | null = null;
      if (isFdm && runtimeLane === "fdm") {
        try {
          const committedScene = await api.model.scene({
            sessionScopeKey: operationSessionScopeKey,
          });
          if (!isCurrentOperation()) return false;
          const currentSceneRevision =
            committedScene.scene_revision ??
            committedScene.revision ??
            null;
          if (typeof currentSceneRevision !== "number" || !Number.isFinite(currentSceneRevision)) {
            throw new Error("Committed scene revision is unavailable.");
          }
          resources.invalidate(SCENE_RESOURCE_KEY, currentSceneRevision);
          const result = await runFdmGridRefreshOperation(operationContext, {
            kind: "fdm_grid_refresh",
            reason: "airbox_policy_commit",
            precondition: { scene_revision: currentSceneRevision },
          });
          if (!isCurrentOperation()) return false;
          fdmReplanMessage = {
            kind: result.status === "completed" ? "success" : result.status === "failed" ? "error" : "warning",
            message:
              result.message ??
              (result.status === "completed"
                ? "Canonical Airbox policy saved. FDM grid replan completed; magnetization was reinitialized from the model."
                : result.status === "failed"
                  ? "Canonical Airbox policy saved, but the FDM grid replan failed."
                  : "Canonical Airbox policy saved. FDM grid replan remains active; see Mesh Jobs."),
          };
        } catch (error) {
          if (!isCurrentOperation()) return false;
          fdmReplanMessage = {
            kind: "warning",
            message: `Canonical Airbox policy saved, but the FDM grid replan could not be submitted: ${
              boundedDisplayText(error instanceof Error ? error.message : String(error)) ?? "unknown command error"
            }`,
          };
        }
      }
      if (!isCurrentOperation()) return false;
      if (!silent && !silentApplyInFlight.current) {
        setFeedback({
          kind: fdmReplanMessage?.kind ?? "success",
          message:
            fdmReplanMessage?.message ??
            (isFdm
              ? "Canonical Airbox policy saved. FDM grid realization remains pending until the runtime lane resolves."
              : "Canonical Airbox policy saved. The realized shared-domain mesh is stale until rebuilt."),
        });
      }
      return true;
    } catch (error) {
      if (!isCurrentOperation()) return false;
      setFeedback({
        kind: "error",
        message: boundedDisplayText(error instanceof Error ? error.message : String(error)) ?? "Backend request failed.",
      });
      return false;
    } finally {
      setPendingOperation((current) => current?.id === operationId ? null : current);
    }
  };

  const build = async () => {
    const operationSessionScopeKey = sessionScopeKey;
    const operationContext = commandContext;
    const isCurrentOperation = () => Boolean(
      operationSessionScopeKey &&
      operationContext.sessionScopeKey === operationSessionScopeKey &&
      operationContext.isCurrentSessionScope?.() === true,
    );
    if (!operationSessionScopeKey || !isCurrentOperation()) {
      setFeedback({ kind: "error", message: "An active session is required to build the shared-domain mesh." });
      return;
    }
    if (pending || buildInFlight.current?.sessionScopeKey === operationSessionScopeKey) return;
    const operationId = ++nextBuildOperationId.current;
    buildInFlight.current = { id: operationId, sessionScopeKey: operationSessionScopeKey };
    setBuildPendingOperation({
      id: operationId,
      identityKey,
      sessionScopeKey: operationSessionScopeKey,
    });
    try {
      if (dirty) {
        let applied = false;
        if (inspectorEditSession) {
          silentApplyInFlight.current = true;
          try {
            applied = await inspectorEditSession.apply();
          } finally {
            silentApplyInFlight.current = false;
          }
        } else {
          applied = await applyPolicy({ silent: true });
        }
        if (!applied) return;
      }
      if (!isCurrentOperation()) return;
      const result = await commands.execute("mesh.build-shared-domain", operationContext);
      if (!isCurrentOperation()) return;
      setFeedback({
        kind: result.status === "completed" ? "success" : result.status === "failed" ? "error" : "warning",
        message: result.message ?? (result.status === "completed"
          ? "Shared-domain mesh build completed."
          : result.status === "failed" ? "Shared-domain mesh build failed."
          : result.status === "pending" ? "Build remains active; see Mesh Jobs."
          : "Mesh build was not submitted."),
      });
    } catch (error) {
      if (!isCurrentOperation()) return;
      setFeedback({
        kind: "error",
        message: boundedDisplayText(error instanceof Error ? error.message : String(error)) ?? "Backend request failed.",
      });
    } finally {
      if (buildInFlight.current?.id === operationId) buildInFlight.current = null;
      setBuildPendingOperation((current) => current?.id === operationId ? null : current);
    }
  };

  const revert = () => {
    setDraftState(initialInspectorDraftState({ baseDraft, baseKey, identityKey }));
    setFeedback(null);
  };

  const loadEffectiveDefaults = () => {
    const seeded = draftFromEffectiveUniverseMeshPolicyResource(resource);
    setDraftState({
      baseKey,
      dirty: true,
      draft: seeded,
      identityKey,
    });
    setFeedback({
      kind: "success",
      message: "Backend-effective Airbox defaults loaded into the draft. Click Apply Airbox Policy to commit.",
    });
  };

  const validation = buildAirboxMeshPolicyReplaceRequest(draft, { lane });
  const validationError = "error" in validation ? validation.error : null;
  const jsonError = airboxMeshPolicyJsonError(draft.configText);
  const fieldError = (label: string) => validationError?.toLowerCase().includes(label.toLowerCase()) ? validationError : undefined;
  useRegisterInspectorEditSession(
    "staged",
    pending,
    dirty,
    sessionScopeKey !== null && validationError === null,
    undefined,
    applyPolicy,
    revert,
  );

  return (
    <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" data-mesh-policy-draft="airbox">
      <InspectorGroup title="Transactions">
        {isFdm ? (
          <FeedbackBanner
            kind="warning"
            message={runtimeLane === "fdm"
              ? "Apply Airbox Policy saves the canonical policy and queues an FDM grid replan."
              : "Apply Airbox Policy saves canonical authoring. FDM grid actions wait for runtime lane resolution."}
          />
        ) : null}
        {!draft.authoredConfigPresent && resource.effective_config ? (
          <FeedbackBanner
            kind="warning"
            message="Using inherited backend Airbox defaults (no explicit authored policy saved yet). Load Effective Defaults or enter values below to author a canonical Airbox policy."
          />
        ) : null}
        {dirty ? (
          <FeedbackBanner
            kind="warning"
            message={
              isFdm
                ? runtimeLane === "fdm"
                  ? "Unapplied changes. Apply Airbox Policy to save and queue the FDM grid replan."
                  : "Unapplied changes. Apply Airbox Policy to save the canonical policy."
                : "Unapplied changes. Apply Airbox Policy or Apply & Build before trusting the current Airbox mesh."
            }
          />
        ) : null}
        <div className="fm-inspector-toolbar">
          <Button disabled={!sessionScopeKey || pending || validationError !== null} size="sm" type="button" variant="primary" onClick={() => void (inspectorEditSession?.apply() ?? applyPolicy())}>
            Apply Airbox Policy
          </Button>
          {!isFdm && runtimeLane === "fem" ? (
            <Button disabled={!sessionScopeKey || pending || buildPending || validationError !== null} size="sm" type="button" variant="secondary" onClick={() => void build()}>
              {buildPending ? "Waiting for mesh build…" : dirty ? "Apply & Build Shared-Domain Mesh" : "Build Shared-Domain Mesh"}
            </Button>
          ) : null}
          {!draft.authoredConfigPresent && resource.effective_config ? (
            <Button disabled={pending} size="sm" type="button" variant="secondary" onClick={loadEffectiveDefaults}>
              Load Effective Defaults
            </Button>
          ) : null}
          <Button disabled={pending} size="sm" type="button" variant="ghost" onClick={revert}>
            Revert
          </Button>
        </div>
        {validationError ? <FeedbackBanner kind="error" message={validationError} /> : null}
        {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
        {!isFdm && runtimeLane !== "fem" ? (
          <>
            <FeedbackBanner
              kind="warning"
              message="The FEM policy can be saved now. Shared-domain mesh actions require a resolved runtime lane."
            />
            <Button size="sm" type="button" variant="secondary" onClick={() => kernel.layout.openBottomPanel("diagnostics")}>
              Open diagnostics
            </Button>
          </>
        ) : null}
      </InspectorGroup>
      <fieldset disabled={jsonError !== null} className="fm-mesh-policy-fields contents">
        <InspectorGroup title="Canonical Authored Parameters" badge="Python round-trip">
          <FieldRow label="Policy revision" value={String(resource.revision)} />
          {!isFdm ? (
            <>
              {NUMBER_FIELDS.map(({ key, label, unit }) => (
                <FormField
                  key={key}
                  label={label}
                  type="text"
                  inputMode="decimal"
                  error={fieldError(label)}
                  unit={unit}
                  unitControl={key === "airboxHmax" || key === "airboxHmin"
                    ? lengthUnitControl(key, label)
                    : undefined}
                  value={draft[key]}
                  onChange={(event) => updateDraft({ [key]: event.target.value })}
                />
              ))}
              <FormField
                label="Element grading"
                type="select"
                value={draft.airboxGrading}
                onChange={(event) =>
                  updateDraft({
                    airboxGrading: event.target.value as AirboxMeshPolicyDraft["airboxGrading"],
                    airboxGradingAuthored: true,
                  })
                }
              >
                {AIRBOX_GRADING_MODES.map((mode) => (
                  <option key={mode} value={mode}>{mode}</option>
                ))}
              </FormField>
            </>
          ) : (
            <FieldRow
              label="FDM policy scope"
              value="Structured-grid universe geometry"
            />
          )}
        </InspectorGroup>
        <InspectorGroup title="Canonical Universe Geometry" badge="Python round-trip">
          <FormField
            label="Domain mode"
            type="select"
            error={fieldError("Domain mode")}
            value={effectiveMode}
            onChange={(event) => updateDraft({ airboxMode: event.target.value })}
          >
            {invalidMode ? <option disabled value={effectiveMode}>Invalid authored mode: {effectiveMode}</option> : null}
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
          </FormField>
          {effectiveMode === "auto" ? (
            <FeedbackBanner
              kind="warning"
              message={draft.airboxMode.trim()
                ? "Automatic bounds are derived from accepted geometry. No manual extents are authored here."
                : "Automatic is the canonical default. Bounds are determined after geometry is available; no zero extents are created."}
            />
          ) : null}
          {VECTOR_FIELDS.filter(({ key }) => key.startsWith("padding") || manualPolicy).map(({ key, label }) => (
            <FormField
              key={key}
              label={label}
              type="text"
              inputMode="decimal"
              error={fieldError(label)}
              unitControl={lengthUnitControl(key, label)}
              value={draft[key]}
              onChange={(event) => updateDraft({ [key]: event.target.value })}
            />
          ))}
          {manualPolicy ? (
            <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-group" id="fm-airbox-manual-bounds" tabIndex={-1}>
              <FeedbackBanner
                kind="warning"
                message="Manual mode requires three positive size components. Center may be omitted (canonical origin); if entered, provide all three components. Values are stored in SI."
              />
              <InspectorGroup title="Backend geometry diagnostics" badge={geometryDiagnostics.status}>
            <p>
              Diagnostics describe the committed backend policy and scene. Apply edited bounds before relying on a refreshed result.
            </p>
                <GeometryBoundsDiagnosticNotice
                  diagnostics={geometryDiagnostics.data ?? null}
                  error={geometryDiagnostics.error}
                  sceneRevision={scene.data?.scene_revision ?? scene.data?.revision ?? null}
                  status={geometryDiagnostics.status}
                  onAdjustBounds={() => {
                    const target = document.getElementById("fm-airbox-manual-bounds");
                    target?.scrollIntoView?.({ block: "center", behavior: "smooth" });
                    target?.focus();
                  }}
                  onOpenDiagnostics={() => kernel.layout.openBottomPanel("diagnostics")}
                  onSelectObject={(objectId) => {
                    const nodeId = `model:object:${objectId}`;
                    kernel.selection.set({
                      kind: "object.root",
                      label: objectId,
                      nodeId,
                      objectId,
                      ref: {
                        kind: "object.root",
                        nodeId,
                        objectId,
                        type: "scene-object",
                        visualizationTargetId: visualizationTargetIdForSceneObject(objectId, null),
                      },
                    }, "inspector");
                  }}
                />
              </InspectorGroup>
            </div>
          ) : null}
        </InspectorGroup>
      </fieldset>
      <InspectorGroup title="Backend-effective Values" badge="read-only">
        <FieldRow label="Source" value="effective_config published by backend" />
        {(isFdm ? FDM_EFFECTIVE_FIELDS : EFFECTIVE_FIELDS).map(([key, label]) => (
          <FieldRow
            key={key}
            label={label}
            value={displayEffectiveValue(resource.effective_config?.[key])}
            unit={airboxEffectiveLengthUnit(key)}
          />
        ))}
        <FieldRow
          label="Unknown effective keys"
          value={String(Object.keys(resource.effective_config ?? {}).filter((key) => !EFFECTIVE_FIELDS.some(([known]) => known === key)).length)}
        />
        <FieldRow label="Effective key count" value={String(Object.keys(resource.effective_config ?? {}).length)} />
      </InspectorGroup>
      {!isFdm ? (
        <InspectorGroup title="Advanced Authored Policy JSON" badge="Python round-trip" collapsible defaultOpen={false}>
          <FormField
            label="Advanced universe policy JSON"
            error={jsonError ?? undefined}
            hint="JSON and structured controls edit the same draft. Resolve invalid JSON before using structured controls."
            rows={8}
            type="textarea"
            value={draft.configText}
            onChange={(event) => updateDraft({ configText: event.target.value })}
          />
        </InspectorGroup>
      ) : null}

    </div>
  );
}
