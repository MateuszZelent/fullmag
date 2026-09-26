"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  authoringWriteOptions,
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import {
  useMeshBuildCurrent,
  useMeshRegionMembershipResource,
  useModelCouplingsResource,
  useModelMaterialFieldsResource,
  useModelRegionDiagnosticsResource,
  useModelRegionsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import { visualizationTargetIdForSceneObject } from "@/kernel/selection/selectionTypes";

import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import type { InspectorPanelProps } from "../inspectorTypes";
import { FormField } from "../primitives/FormField";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
  type InspectorDraftState,
} from "./inspectorDraftState";
import {
  buildObjectRegionPatch,
  clampObjectRegionDraftShapeToOwnerBounds,
  defaultMaterialOverrideDraft,
  formatRegionPhysicalScalar,
  objectRegionDraftFromModel,
  objectRegionDraftDirty,
  objectRegionDraftIdentityKey,
  objectRegionDraftKey,
  parseRegionPhysicalScalar,
  resolveRegionCouplingDependencies,
  resolveObjectRegionPanelModel,
  validateObjectRegionDraft,
  type ObjectRegionDraft,
  type RegionMeshPolicyDraft,
  type RegionShapeDraft,
} from "./ObjectRegionsPanelModel";
import { resolveRegionMeshLifecycle } from "@/shared/domain/mesh/regionMeshLifecycle";
import { syncAuthoringScriptBestEffort } from "./ObjectMagneticTexturePanelViewModel";
import { findLastRegionSelection, regionNodeId } from "./RegionsListPanelModel";
import { publishRegionAuthoringScene } from "./regionAuthoringInvalidation";

import { ObjectRegionDiagnosticsPanel as ObjectRegionDiagnosticsPanelImpl } from "./region/ObjectRegionDiagnosticsPanel";
import { ObjectRegionGeometryPanel as ObjectRegionGeometryPanelImpl } from "./region/ObjectRegionGeometryPanel";
import { ObjectRegionMagneticParametersPanel as ObjectRegionMagneticParametersPanelImpl } from "./region/ObjectRegionMagneticParametersPanel";
import { ObjectRegionMeshPanel as ObjectRegionMeshPanelImpl } from "./region/ObjectRegionMeshPanel";
import { ObjectRegionNestedRegionsPanel as ObjectRegionNestedRegionsPanelImpl } from "./region/ObjectRegionNestedRegionsPanel";
import { ObjectRegionOverviewPanel as ObjectRegionOverviewPanelImpl } from "./region/ObjectRegionOverviewPanel";
import { ObjectRegionTexturePanel as ObjectRegionTexturePanelImpl } from "./region/ObjectRegionTexturePanel";
import { ObjectRegionVisualizationPanel as ObjectRegionVisualizationPanelImpl } from "./region/ObjectRegionVisualizationPanel";
import type { RegionSubPanelProps } from "./region/shared";
import { resolveMeshInspectorLane } from "./fdmMeshInspectorModel";

type Feedback =
  | {
      kind: "error" | "success" | "warning";
      message: string;
    }
  | null;

export function PhysicalScalarField({
  disabled,
  label,
  unit,
  value,
  onValueChange,
}: {
  disabled?: boolean;
  label: string;
  unit?: string;
  value: number;
  onValueChange: (next: number) => void;
}) {
  const formatted = formatRegionPhysicalScalar(value);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(formatted);
  const displayValue = editing ? text : formatted;
  const parsed = parseRegionPhysicalScalar(displayValue);
  const invalid = editing && parsed === null;

  return (
    <FormField
      label={label}
      inputMode="decimal"
      type="text"
      unit={unit}
      value={displayValue}
      disabled={disabled}
      error={invalid ? "Enter a valid SI value" : undefined}
      invalid={invalid}
      onBlur={() => {
        setEditing(false);
        setText(formatRegionPhysicalScalar(value));
      }}
      onChange={(event) => {
        const nextText = event.target.value;
        setText(nextText);
        const parsed = parseRegionPhysicalScalar(nextText);
        if (parsed !== null && !Object.is(parsed, value)) {
          onValueChange(parsed);
        }
      }}
      onFocus={() => {
        setText(formatted);
        setEditing(true);
      }}
    />
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function revisionFromScene(scene: unknown): number | null {
  if (scene && typeof scene === "object" && ("scene_revision" in scene || "revision" in scene)) {
    const value = scene as { revision?: unknown; scene_revision?: unknown };
    const revision = value.scene_revision ?? value.revision;
    if (typeof revision === "number" && Number.isFinite(revision)) {
      return revision;
    }
  }
  return null;
}

export function ObjectRegionsPanel(props: InspectorPanelProps) {
  return useObjectRegionsPanelView(props);
}

function useObjectRegionsPanelView({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const {
    api,
    resources,
    selection: selectionController,
  } = kernel;
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionDiscretization = useSessionStatusSelector(
    (status) => status.data?.domain.discretization ?? null,
  );
  const meshLane = resolveMeshInspectorLane(sessionDiscretization);
  const regionVisualizationSelection =
    selection.kind === "object.region.visualization";
  const scene = useSceneResource({
    enabled: !regionVisualizationSelection || meshLane === "fem",
  });
  const regions = useModelRegionsResource();
  const materialFields = useModelMaterialFieldsResource();
  const regionDiagnostics = useModelRegionDiagnosticsResource();
  const couplings = useModelCouplingsResource();

  const model = useMemo(
    () =>
      resolveObjectRegionPanelModel(
        selection,
        scene.data,
        regions.data ?? null,
        materialFields.data ?? null,
        regionDiagnostics.data ?? null,
      ),
    [materialFields.data, regionDiagnostics.data, regions.data, scene.data, selection],
  );

  const baseDraft = useMemo(() => objectRegionDraftFromModel(model), [model]);
  const draftKey = `${sessionScopeKey ?? "no-session"}:${objectRegionDraftKey(model)}`;
  const draftIdentityKey = objectRegionDraftIdentityKey(model);
  const [draftState, setDraftState] = useState<
    InspectorDraftState<ObjectRegionDraft>
  >(() =>
    initialInspectorDraftState({
      baseDraft,
      baseKey: draftKey,
      identityKey: draftIdentityKey,
    }),
  );
  const [feedbackState, setFeedbackState] = useState<{
    identityKey: string;
    sessionScopeKey: string | null;
    value: Feedback;
  } | null>(null);
  const feedback = feedbackState?.sessionScopeKey === sessionScopeKey &&
    feedbackState.identityKey === draftIdentityKey
    ? feedbackState.value
    : null;
  const setFeedback = useCallback(
    (value: Feedback) => setFeedbackState({ identityKey: draftIdentityKey, sessionScopeKey, value }),
    [draftIdentityKey, sessionScopeKey],
  );
  const [pendingOperation, setPendingOperation] = useState<{
    id: number;
    identityKey: string;
    sessionScopeKey: string;
  } | null>(null);
  const nextOperationId = useRef(0);
  const pending = pendingOperation?.sessionScopeKey === sessionScopeKey &&
    pendingOperation.identityKey === draftIdentityKey;
  const [buildPendingOperation, setBuildPendingOperation] = useState<{
    id: number;
    identityKey: string;
    sessionScopeKey: string;
  } | null>(null);
  const nextBuildOperationId = useRef(0);
  const buildInFlight = useRef<{
    id: number;
    identityKey: string;
    sessionScopeKey: string;
  } | null>(null);
  const buildPending = buildPendingOperation?.sessionScopeKey === sessionScopeKey &&
    buildPendingOperation.identityKey === draftIdentityKey;
  const { draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey: draftKey,
    identityKey: draftIdentityKey,
    isDirty: objectRegionDraftDirty,
    state: draftState,
  });

  const membership = useMeshRegionMembershipResource(model.objectId, model.regionId, {
    enabled:
      meshLane === "fem" &&
      model.mode === "committed" &&
      model.regionId !== "none",
  });
  const activeBuild = useMeshBuildCurrent({
    enabled:
      meshLane === "fem" &&
      model.mode === "committed" &&
      model.regionId !== "none",
  });
  const regionMeshLifecycle = useMemo(
    () =>
      meshLane === "fem"
        ? resolveRegionMeshLifecycle({
            build: activeBuild.data,
            draftDirty: objectRegionDraftDirty(draft, baseDraft),
            membership: membership.data,
            policyEnabled: draft.meshPolicy.enabled,
            supported: !model.diagnostics.some(
              (diagnostic) =>
                diagnostic.capabilityGate === "regions.mesh_policy" &&
                diagnostic.severity === "error",
            ),
          })
        : null,
    [activeBuild.data, baseDraft, draft, membership.data, meshLane, model.diagnostics],
  );

  const canWriteRegion =
    model.mode === "committed" && model.source === "authored_object_region";
  const sessionAvailable = sessionScopeKey !== null;
  const femMeshLane = meshLane === "fem";
  const canWriteMeshRegion = canWriteRegion && femMeshLane;
  function captureRegionMutationContext(sourceDetail: string) {
    return captureAuthoringMutationFence(
      createCommandContext("inspector", kernel, {
        sessionScopeKey,
        sourceDetail,
        input: { object_id: model.objectId, region_id: model.regionId },
      }),
    );
  }

  function isCurrentRegionMutation(context: ReturnType<typeof captureRegionMutationContext>): boolean {
    return context.isCurrentSessionScope?.() === true;
  }

  function beginRegionOperation(): number | null {
    if (!sessionScopeKey) return null;
    const id = ++nextOperationId.current;
    setPendingOperation({ id, identityKey: draftIdentityKey, sessionScopeKey });
    return id;
  }

  function finishRegionOperation(id: number): void {
    setPendingOperation((current) => current?.id === id ? null : current);
  }

  function requireRegionBaseRevision(baseRevision: number | null): number {
    const revision = baseRevision ?? model.revision;
    if (typeof revision !== "number" || !Number.isFinite(revision)) {
      throw new Error("A finite committed scene revision is required for region writes.");
    }
    return revision;
  }

  const couplingDependencies = useMemo(
    () =>
      resolveRegionCouplingDependencies(
        model.objectId,
        model.regionId,
        couplings.data ?? null,
      ),
    [couplings.data, model.objectId, model.regionId],
  );

  function updateDraft(patch: Partial<ObjectRegionDraft>): void {
    setDraftState(
      updateInspectorDraftState({
        baseDraft,
        baseKey: draftKey,
        currentDraft: draft,
        identityKey: draftIdentityKey,
        isDirty: () => true,
        patch,
      }),
    );
  }

  function updateShape(patch: Partial<RegionShapeDraft>): void {
    const nextShape = {
      ...draft.shape,
      ...patch,
    };
    updateDraft({
      shape: clampObjectRegionDraftShapeToOwnerBounds(
        nextShape,
        draft.ownerBounds,
        draft.frame,
      ),
    });
  }

  function updateMeshPolicy(patch: Partial<RegionMeshPolicyDraft>): void {
    updateDraft({
      meshPolicy: {
        ...draft.meshPolicy,
        ...patch,
      },
    });
  }

  function updateMaterialOverride(
    index: number,
    patch: Partial<ObjectRegionDraft["materialOverrides"][number]>,
  ): void {
    const next = draft.materialOverrides.map((override, overrideIndex) =>
      overrideIndex === index ? { ...override, ...patch } : override,
    );
    updateDraft({ materialOverrides: next });
  }

  function addMaterialOverride(): void {
    updateDraft({
      materialOverrides: [
        ...draft.materialOverrides,
        defaultMaterialOverrideDraft(draft.priority),
      ],
    });
  }

  function removeMaterialOverride(index: number): void {
    updateDraft({
      materialOverrides: draft.materialOverrides.filter(
        (_override, overrideIndex) => overrideIndex !== index,
      ),
    });
  }

  function updateShapeVector(
    key: "axis" | "center" | "size",
    index: 0 | 1 | 2,
    value: number,
  ): void {
    const next = [...draft.shape[key]] as [number, number, number];
    next[index] = value;
    updateShape({ [key]: next });
  }

  function selectRegion(regionId: string, name: string): void {
    const nodeId = regionNodeId(model.objectId, regionId);
    selectionController.set(
      {
        kind: "object.region",
        label: name,
        nodeId,
        objectId: model.objectId,
        ref: {
          kind: "object.region",
          nodeId,
          objectId: model.objectId,
          regionId,
          type: "scene-object",
          visualizationTargetId: visualizationTargetIdForSceneObject(
            model.objectId,
            regionId,
          ),
        },
      },
      "inspector",
    );
  }

  async function applyRegion(): Promise<boolean> {
    if (!canWriteRegion) {
      setFeedback({ kind: "error", message: "Select an authored object region." });
      return false;
    }
    const validationErrors = validateObjectRegionDraft(draft, {
      meshPolicyLane: meshLane,
    });
    if (validationErrors.length > 0) {
      setFeedback({ kind: "error", message: validationErrors[0] ?? "Invalid region draft." });
      return false;
    }

    const operationContext = captureRegionMutationContext("object-region-apply");
    const operationSessionScopeKey = operationContext.sessionScopeKey;
    if (!operationSessionScopeKey || !isCurrentRegionMutation(operationContext)) {
      setFeedback({ kind: "error", message: "An active session is required to update this region." });
      return false;
    }
    const operationId = beginRegionOperation();
    if (operationId === null) return false;
    try {
      const response = await runAuthoringMutationWithHistory(
        operationContext,
        `Update region ${model.regionId}`,
        async ({ baseRevision }) => {
          const revision = requireRegionBaseRevision(baseRevision);
          const options = authoringWriteOptions(revision, operationSessionScopeKey);
          if (!options?.sessionScopeKey || options.baseRevision === undefined) {
            throw new Error("A scoped region revision is required for this write.");
          }
          return api.model.patchObjectRegionResource(
            model.objectId,
            model.regionId,
            buildObjectRegionPatch(draft, { meshPolicyLane: meshLane }),
            options,
          );
        },
      );
      const revision = revisionFromScene(response);
      if (!isCurrentRegionMutation(operationContext)) return false;
      if (revision === null) throw new Error("The region update returned no committed scene revision.");
      publishRegionAuthoringScene(
        resources,
        response,
        revision,
        undefined,
        operationSessionScopeKey,
      );
      const syncWarning = await syncAuthoringScriptBestEffort(
        api,
        operationSessionScopeKey,
      );
      if (!isCurrentRegionMutation(operationContext)) return false;
      setFeedback({
        kind: "success",
        message: syncWarning
          ? `Object region updated. Authoring script sync skipped: ${syncWarning}`
          : "Object region updated.",
      });
      return true;
    } catch (error) {
      if (!isCurrentRegionMutation(operationContext)) return false;
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishRegionOperation(operationId);
    }
  }

  async function buildRegion(): Promise<void> {
    if (pending || (buildInFlight.current?.sessionScopeKey === sessionScopeKey &&
      buildInFlight.current.identityKey === draftIdentityKey)) return;
    if (meshLane !== "fem") {
      setFeedback({
        kind: "error",
        message:
          meshLane === "fdm"
            ? "FDM region membership is read-only; FEM shared-domain mesh builds are not applicable."
            : "Mesh lane is unresolved; FEM shared-domain mesh builds are unavailable.",
      });
      return;
    }
    if (!canWriteRegion) {
      setFeedback({ kind: "error", message: "Select an authored object region." });
      return;
    }
    if (!regionMeshLifecycle) {
      setFeedback({
        kind: "error",
        message: "FEM region mesh lifecycle is unavailable outside the FEM lane.",
      });
      return;
    }
    if (regionMeshLifecycle.status === "unsupported") {
      setFeedback({ kind: "error", message: regionMeshLifecycle.reason });
      return;
    }
    const operationContext = captureRegionMutationContext("object-region-mesh-build");
    const operationSessionScopeKey = operationContext.sessionScopeKey;
    if (!operationSessionScopeKey || !isCurrentRegionMutation(operationContext)) {
      setFeedback({ kind: "error", message: "An active session is required to build this region mesh." });
      return;
    }
    const operationId = ++nextBuildOperationId.current;
    buildInFlight.current = {
      id: operationId,
      identityKey: draftIdentityKey,
      sessionScopeKey: operationSessionScopeKey,
    };
    setBuildPendingOperation({
      id: operationId,
      identityKey: draftIdentityKey,
      sessionScopeKey: operationSessionScopeKey,
    });
    try {
      if (objectRegionDraftDirty(draft, baseDraft) && !(await applyRegion())) return;
      if (!isCurrentRegionMutation(operationContext)) return;
      const result = await kernel.commands.execute("mesh.build-shared-domain", operationContext);
      if (!isCurrentRegionMutation(operationContext)) return;
      setFeedback({
        kind: result.status === "completed" ? "success" : result.status === "failed" ? "error" : "warning",
        message: result.message ?? (result.status === "completed"
          ? "Shared-domain mesh build completed."
          : result.status === "failed" ? "Shared-domain mesh build failed."
          : result.status === "pending" ? "Build remains active; see Mesh Jobs."
          : "Mesh build was not submitted."),
      });
    } catch (error) {
      if (!isCurrentRegionMutation(operationContext)) return;
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      if (buildInFlight.current?.id === operationId) buildInFlight.current = null;
      setBuildPendingOperation((current) => current?.id === operationId ? null : current);
    }
  }

  async function duplicateRegion(): Promise<void> {
    if (!canWriteRegion) {
      setFeedback({ kind: "error", message: "Select an authored object region." });
      return;
    }

    const operationContext = captureRegionMutationContext("object-region-duplicate");
    const operationSessionScopeKey = operationContext.sessionScopeKey;
    if (!operationSessionScopeKey || !isCurrentRegionMutation(operationContext)) {
      setFeedback({ kind: "error", message: "An active session is required to duplicate this region." });
      return;
    }
    const operationId = beginRegionOperation();
    if (operationId === null) return;
    try {
      const response = await runAuthoringMutationWithHistory(
        operationContext,
        `Duplicate region ${model.regionId}`,
        async ({ baseRevision }) => {
          const revision = requireRegionBaseRevision(baseRevision);
          const options = authoringWriteOptions(revision, operationSessionScopeKey);
          if (!options?.sessionScopeKey || options.baseRevision === undefined) {
            throw new Error("A scoped region revision is required for this write.");
          }
          return api.model.duplicateObjectRegion(
            model.objectId,
            model.regionId,
            {},
            options,
          );
        },
      );
      const revision = revisionFromScene(response);
      if (!isCurrentRegionMutation(operationContext)) return;
      if (revision === null) throw new Error("The duplicated region returned no committed scene revision.");
      publishRegionAuthoringScene(
        resources,
        response,
        revision,
        undefined,
        operationSessionScopeKey,
      );
      const duplicated = findLastRegionSelection(
        response,
        model.objectId,
        model.regionId,
      );
      if (duplicated) {
        selectRegion(duplicated.regionId, duplicated.name);
      }
      const syncWarning = await syncAuthoringScriptBestEffort(
        api,
        operationSessionScopeKey,
      );
      if (!isCurrentRegionMutation(operationContext)) return;
      setFeedback({
        kind: "success",
        message: syncWarning
          ? `Object region duplicated. Authoring script sync skipped: ${syncWarning}`
          : "Object region duplicated.",
      });
    } catch (error) {
      if (!isCurrentRegionMutation(operationContext)) return;
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      finishRegionOperation(operationId);
    }
  }

  async function deleteRegion(): Promise<void> {
    if (!canWriteRegion) {
      setFeedback({ kind: "error", message: "Select an authored object region." });
      return;
    }

    const operationContext = captureRegionMutationContext("object-region-delete");
    const operationSessionScopeKey = operationContext.sessionScopeKey;
    if (!operationSessionScopeKey || !isCurrentRegionMutation(operationContext)) {
      setFeedback({ kind: "error", message: "An active session is required to delete this region." });
      return;
    }
    const operationId = beginRegionOperation();
    if (operationId === null) return;
    try {
      const transaction = await runAuthoringMutationWithHistory(
        operationContext,
        `Delete region ${model.regionId}`,
        async ({ baseRevision }) => {
          const revision = requireRegionBaseRevision(baseRevision);
          const options = authoringWriteOptions(revision, operationSessionScopeKey);
          if (!options?.sessionScopeKey || options.baseRevision === undefined) {
            throw new Error("A scoped region revision is required for this write.");
          }
          return api.model.deleteObjectRegion(
            model.objectId,
            model.regionId,
            options,
          );
        },
      );
      if (!isCurrentRegionMutation(operationContext)) return;
      const response = transaction.committed_scene;
      const revision = transaction.scene_revision;
      if (typeof revision !== "number" || !Number.isFinite(revision)) {
        throw new Error("The region deletion returned no committed scene revision.");
      }
      publishRegionAuthoringScene(
        resources,
        response,
        revision,
        undefined,
        operationSessionScopeKey,
      );
      const fallback = findLastRegionSelection(
        response,
        model.objectId,
        model.regionId,
      );
      if (fallback) {
        selectRegion(fallback.regionId, fallback.name);
      } else {
        selectionController.set(
          {
            kind: "object.regions",
            label: "Regions",
            nodeId: `model:object:${model.objectId}:regions`,
            objectId: model.objectId,
            ref: {
              kind: "object.regions",
              nodeId: `model:object:${model.objectId}:regions`,
              objectId: model.objectId,
              type: "scene-object",
              visualizationTargetId: visualizationTargetIdForSceneObject(
                model.objectId,
              ),
            },
          },
          "inspector",
        );
      }
      const syncWarning = await syncAuthoringScriptBestEffort(
        api,
        operationSessionScopeKey,
      );
      if (!isCurrentRegionMutation(operationContext)) return;
      setFeedback({
        kind: "success",
        message: syncWarning
          ? `Object region deleted. Authoring script sync skipped: ${syncWarning}`
          : "Object region deleted.",
      });
    } catch (error) {
      if (!isCurrentRegionMutation(operationContext)) return;
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      finishRegionOperation(operationId);
    }
  }

  const revert = () => {
    setDraftState(initialInspectorDraftState({ baseDraft, baseKey: draftKey, identityKey: draftIdentityKey }));
    setFeedback(null);
  };
  const validationErrors = validateObjectRegionDraft(draft, { meshPolicyLane: meshLane });
  useRegisterInspectorEditSession(
    canWriteRegion ? "staged" : null,
    pending,
    objectRegionDraftDirty(draft, baseDraft),
    sessionAvailable && canWriteRegion && validationErrors.length === 0,
    undefined,
    applyRegion,
    revert,
    { historyMode: "mutation-owned" },
  );

  const subProps: RegionSubPanelProps = {
    model,
    draft,
    pending,
    sessionAvailable,
    buildPending,
    membership: membership.data ?? null,
    draftDirty: objectRegionDraftDirty(draft, baseDraft),
    buildRegion,
    regionMeshLifecycle,
    canWriteRegion,
    canWriteMeshRegion,
    meshLane,
    updateDraft,
    updateShape,
    updateShapeVector,
    updateMeshPolicy,
    updateMaterialOverride,
    addMaterialOverride,
    removeMaterialOverride,
    applyRegion,
    duplicateRegion,
    deleteRegion,
    revert,
    feedback,
    materialFields: materialFields.data ?? null,
    couplingDependencies,
  };

  switch (selection.kind) {
    case "object.region.geometry":
    case "object.region.shape":
      return <ObjectRegionGeometryPanelImpl {...subProps} />;
    case "object.region.magnetic-parameters":
    case "object.region.material":
      return <ObjectRegionMagneticParametersPanelImpl {...subProps} />;
    case "object.region.mesh":
      return <ObjectRegionMeshPanelImpl {...subProps} />;
    case "object.region.regions":
      return <ObjectRegionNestedRegionsPanelImpl {...subProps} />;
    case "object.region.diagnostics":
      return <ObjectRegionDiagnosticsPanelImpl {...subProps} />;
    case "object.region.texture":
      return <ObjectRegionTexturePanelImpl {...subProps} />;
    case "object.region.visualization":
      return <ObjectRegionVisualizationPanelImpl {...subProps} />;
    case "object.region":
    default:
      return <ObjectRegionOverviewPanelImpl {...subProps} />;
  }
}

export function ObjectRegionOverviewPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionGeometryPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionMagneticParametersPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionMeshPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionTexturePanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionVisualizationPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionNestedRegionsPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}

export function ObjectRegionDiagnosticsPanel(props: InspectorPanelProps) {
  return <ObjectRegionsPanel {...props} />;
}
