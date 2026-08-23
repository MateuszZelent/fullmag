"use client";

import { useCallback, useMemo, useState } from "react";

import {
  acknowledgedAuthoringSceneRevision,
  invalidateAuthoringMutationDependents,
} from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";
import {
  publishCommittedSceneResource,
  resolveMaterialResourceKey,
  resolveObjectInteractionResourceKey,
  useMaterialResource,
  useObjectInteractionResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { Vector3Field } from "../primitives/Vector3Field";
import { ObjectAbsorbingBoundaryPanel } from "./ObjectAbsorbingBoundaryPanel";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
  type InspectorDraftState,
} from "./inspectorDraftState";
import { resolveGeometryObjectDraft } from "./geometryObjectPanelModel";
import {
  buildCreateMaterialDraft,
  buildMaterialAssignmentPatch,
  buildMaterialParametersPatch,
  buildUniaxialAnisotropyPatch,
  createMaterialThenAssign,
  magneticParametersDraftFromResource,
  magneticParametersDraftDirty,
  materialParametersDraftKey,
  normalizeMaterialRef,
  MaterialAssignmentAfterCreateError,
  type CreateMaterialDraft,
  type MagneticParametersDraft,
} from "./ObjectMaterialPanelModel";

interface AnisotropyDraft {
  present: boolean;
  ku1: string;
  axisX: string;
  axisY: string;
  axisZ: string;
}

function anisotropyDraftFromParams(
  present: boolean,
  params: unknown,
): AnisotropyDraft {
  const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  const axis = Array.isArray(p["axis"]) ? (p["axis"] as unknown[]) : [0, 0, 1];
  return {
    present,
    ku1: typeof p["ku1"] === "number" ? String(p["ku1"]) : "",
    axisX: typeof axis[0] === "number" ? String(axis[0]) : "0",
    axisY: typeof axis[1] === "number" ? String(axis[1]) : "0",
    axisZ: typeof axis[2] === "number" ? String(axis[2]) : "1",
  };
}

type Feedback =
  | {
      kind: "error" | "success";
      message: string;
    }
  | null;

type PendingOperation = "anisotropy" | "assignment" | "create-assign" | "parameters" | "retry-assign";

function newMaterialDraft(objectName: string): CreateMaterialDraft {
  const slug = objectName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    aex: "1.3e-11",
    alpha: "0.01",
    anisotropyAxis: ["0", "0", "1"],
    ku1: "",
    materialId: `mat:${slug || "new-material"}`,
    ms: "8e5",
    name: `${objectName || "New object"} material`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function useObjectMaterialPanelState(selection: InspectorPanelProps["selection"]) {
  const { api, resources } = useKernel();
  const scene = useSceneResource();
  const object = resolveGeometryObjectDraft(selection, scene.data);
  const materialId = normalizeMaterialRef(object.material);
  const material = useMaterialResource(materialId);
  const anisotropyInteraction = useObjectInteractionResource(
    object.objectId || null,
    "uniaxial_anisotropy",
  );
  const baseAnisotropyDraft = useMemo(
    () =>
      anisotropyDraftFromParams(
        anisotropyInteraction.data?.present ?? false,
        anisotropyInteraction.data?.params ?? {},
      ),
    [anisotropyInteraction.data],
  );
  const [anisotropyDraftState, setAnisotropyDraftState] = useState<{
    draft: AnisotropyDraft;
    key: string;
  }>({ draft: baseAnisotropyDraft, key: "" });
  const anisotropyDraftKey = [
    object.objectId,
    String(anisotropyInteraction.data?.present ?? false),
    String(anisotropyInteraction.data?.params ? JSON.stringify(anisotropyInteraction.data.params) : ""),
  ].join(":");
  const anisotropyDraft =
    anisotropyDraftState.key === anisotropyDraftKey
      ? anisotropyDraftState.draft
      : baseAnisotropyDraft;
  const baseDraft = useMemo(
    () =>
      magneticParametersDraftFromResource(
        object.material,
        material.data ?? null,
      ),
    [material.data, object.material],
  );
  const assignmentKey = [
    object.mode,
    object.objectId,
    object.baseRevision ?? "unknown",
    object.material,
  ].join(":");
  const draftKey = `${assignmentKey}:${materialParametersDraftKey(
    object.material,
    material.data ?? null,
  )}`;
  const draftIdentityKey = [object.mode, object.objectId].join(":");
  const [draftState, setDraftState] = useState<
    InspectorDraftState<MagneticParametersDraft>
  >(() =>
    initialInspectorDraftState({
      baseDraft,
      baseKey: draftKey,
      identityKey: draftIdentityKey,
    }),
  );
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pendingOperations, setPendingOperations] = useState<ReadonlySet<PendingOperation>>(
    () => new Set(),
  );
  const [createDraftState, setCreateDraftState] = useState<{
    draft: CreateMaterialDraft;
    objectId: string;
  }>(() => ({ draft: newMaterialDraft(object.name), objectId: object.objectId }));
  const createDraft = createDraftState.objectId === object.objectId
    ? createDraftState.draft
    : newMaterialDraft(object.name);
  const [assignmentFailure, setAssignmentFailure] = useState<{
    error: MaterialAssignmentAfterCreateError;
    refreshCompleted: boolean;
    rebasedRevision: number | null;
  } | null>(null);
  const { draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey: draftKey,
    identityKey: draftIdentityKey,
    isDirty: magneticParametersDraftDirty,
    state: draftState,
  });
  const draftMaterialId = normalizeMaterialRef(draft.materialRef);
  const parametersTargetChanged = draftMaterialId !== materialId;

  function startPending(operation: PendingOperation): void {
    setPendingOperations((current) => new Set(current).add(operation));
  }

  function finishPending(operation: PendingOperation): void {
    setPendingOperations((current) => {
      const next = new Set(current);
      next.delete(operation);
      return next;
    });
  }

  function updateAnisotropyDraft(patch: Partial<AnisotropyDraft>): void {
    setAnisotropyDraftState((current) => ({
      draft: {
        ...(current.key === anisotropyDraftKey ? current.draft : baseAnisotropyDraft),
        ...patch,
      },
      key: anisotropyDraftKey,
    }));
  }

  async function applyAnisotropy(): Promise<boolean> {
    if (!object.objectId || object.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return false;
    }
    const anisotropy = buildUniaxialAnisotropyPatch(
      anisotropyDraft.ku1,
      [anisotropyDraft.axisX, anisotropyDraft.axisY, anisotropyDraft.axisZ],
    );
    if ("error" in anisotropy) {
      setFeedback({ kind: "error", message: anisotropy.error });
      return false;
    }
    const value = anisotropy.value ?? { axis: [0, 0, 1] as [number, number, number], ku1: 0 };
    startPending("anisotropy");
    try {
      const response = await api.model.patchObjectInteraction(
        object.objectId,
        "uniaxial_anisotropy",
        {
          present: anisotropyDraft.present,
          params: { ku1: value.ku1, axis: value.axis },
        },
      );
      const revision = acknowledgedAuthoringSceneRevision(response);
      resources.invalidate(
        resolveObjectInteractionResourceKey(object.objectId, "uniaxial_anisotropy"),
        revision,
      );
      invalidateMagneticParameterResources(revision);
      setFeedback({ kind: "success", message: "Uniaxial anisotropy updated." });
      return true;
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishPending("anisotropy");
    }
  }

  function updateDraft(patch: Partial<MagneticParametersDraft>): void {
    setDraftState(
      updateInspectorDraftState({
        baseDraft,
        baseKey: draftKey,
        currentDraft: draft,
        identityKey: draftIdentityKey,
        isDirty: magneticParametersDraftDirty,
        patch,
      }),
    );
  }

  async function applyMaterial(): Promise<boolean> {
    if (object.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return false;
    }

    startPending("assignment");
    try {
      const sceneResponse = await api.model.patchObject(
        object.objectId,
        buildMaterialAssignmentPatch(draft, object.baseRevision),
      );
      const revision = acknowledgedAuthoringSceneRevision(sceneResponse);
      invalidateMagneticParameterResources(revision);
      setFeedback({
        kind: "success",
        message: "Object material assignment updated.",
      });
      return true;
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishPending("assignment");
    }
  }

  async function applyParameters(): Promise<boolean> {
    if (!materialId || !material.data) {
      setFeedback({
        kind: "error",
        message: "No committed material asset is assigned to this object.",
      });
      return false;
    }
    if (parametersTargetChanged) {
      setFeedback({
        kind: "error",
        message: "Apply the material assignment before editing its parameters.",
      });
      return false;
    }

    const result = buildMaterialParametersPatch(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return false;
    }

    startPending("parameters");
    try {
      const response = await api.model.patchMaterial(materialId, result.patch);
      const revision = acknowledgedAuthoringSceneRevision(response);
      resources.invalidate(resolveMaterialResourceKey(materialId), revision);
      invalidateMagneticParameterResources(revision);
      setFeedback({
        kind: "success",
        message: "Magnetic parameters updated.",
      });
      return true;
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
      return false;
    } finally {
      finishPending("parameters");
    }
  }

  function invalidateMagneticParameterResources(revision: number): void {
    invalidateAuthoringMutationDependents(resources, "material", revision);
  }

  function updateCreateDraft(patch: Partial<CreateMaterialDraft>): void {
    setCreateDraftState((current) => ({
      draft: {
        ...(current.objectId === object.objectId
          ? current.draft
          : newMaterialDraft(object.name)),
        ...patch,
      },
      objectId: object.objectId,
    }));
    setFeedback(null);
  }

  function stageDeferredAnisotropy(
    anisotropy: { axis: [number, number, number]; ku1: number } | null,
  ): void {
    if (!anisotropy) return;
    setAnisotropyDraftState({
      draft: {
        axisX: String(anisotropy.axis[0]),
        axisY: String(anisotropy.axis[1]),
        axisZ: String(anisotropy.axis[2]),
        ku1: String(anisotropy.ku1),
        present: true,
      },
      key: anisotropyDraftKey,
    });
  }

  async function createAndAssignMaterial(): Promise<void> {
    if (!object.objectId || object.mode !== "committed" || object.baseRevision === null) {
      setFeedback({ kind: "error", message: "No committed scene object with a known revision." });
      return;
    }
    const validation = buildCreateMaterialDraft(createDraft);
    if ("error" in validation) {
      setFeedback({ kind: "error", message: validation.error });
      return;
    }
    startPending("create-assign");
    setAssignmentFailure(null);
    try {
      const result = await createMaterialThenAssign(
        api,
        object.objectId,
        createDraft,
        object.baseRevision,
        (created) => {
          publishCommittedSceneResource(
            resources,
            created.committed_scene,
            created.scene_revision,
            undefined,
            false,
          );
          resources.invalidate(
            resolveMaterialResourceKey(validation.value.materialId),
            created.scene_revision,
          );
          invalidateMagneticParameterResources(created.scene_revision);
        },
      );
      const assignmentRevision = acknowledgedAuthoringSceneRevision(result.assigned);
      publishCommittedSceneResource(
        resources,
        result.assigned,
        assignmentRevision,
        undefined,
        false,
      );
      invalidateMagneticParameterResources(assignmentRevision);
      updateDraft({ materialRef: result.materialId });
      stageDeferredAnisotropy(result.deferredAnisotropy);
      setFeedback({
        kind: "success",
        message: result.deferredAnisotropy
          ? "Material created and assigned. Ku1 draft is ready; apply anisotropy separately."
          : "Material created and assigned.",
      });
    } catch (error) {
      if (error instanceof MaterialAssignmentAfterCreateError) {
        stageDeferredAnisotropy(error.deferredAnisotropy);
        setAssignmentFailure({ error, refreshCompleted: false, rebasedRevision: null });
        setFeedback({
          kind: "error",
          message: "Material was created and remains in the library, but assignment failed. Refresh and explicitly rebase before retrying assignment.",
        });
      } else {
        setFeedback({ kind: "error", message: errorMessage(error) });
      }
    } finally {
      finishPending("create-assign");
    }
  }

  function rebaseFailedAssignment(): void {
    if (
      !assignmentFailure ||
      !assignmentFailure.refreshCompleted ||
      scene.status !== "ready" ||
      typeof scene.data?.revision !== "number" ||
      scene.data.revision <= assignmentFailure.error.assignmentBaseRevision
    ) return;
    setAssignmentFailure({
      ...assignmentFailure,
      rebasedRevision: scene.data.revision,
    });
    setFeedback({ kind: "success", message: `Assignment rebased to scene revision ${scene.data.revision}.` });
  }

  async function refreshFailedAssignment(): Promise<void> {
    if (!assignmentFailure) return;
    await scene.refetch();
    setAssignmentFailure((current) =>
      current?.error === assignmentFailure.error
        ? { ...current, refreshCompleted: true }
        : current,
    );
  }

  async function retryFailedAssignment(): Promise<void> {
    if (!assignmentFailure || assignmentFailure.rebasedRevision === null) return;
    startPending("retry-assign");
    try {
      const assigned = await assignmentFailure.error.retry(api, assignmentFailure.rebasedRevision);
      const assignmentRevision = acknowledgedAuthoringSceneRevision(assigned);
      publishCommittedSceneResource(resources, assigned, assignmentRevision, undefined, false);
      invalidateMagneticParameterResources(assignmentRevision);
      updateDraft({ materialRef: assignmentFailure.error.materialId });
      setAssignmentFailure(null);
      setFeedback({ kind: "success", message: "Material assignment retry succeeded." });
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      finishPending("retry-assign");
    }
  }

  return {
    anisotropyDraft,
    applyAnisotropy,
    applyMaterial,
    applyParameters,
    assignmentFailure,
    baseAnisotropyDraft,
    baseDraft,
    createAndAssignMaterial,
    createDraft,
    draft,
    draftIdentityKey,
    draftKey,
    feedback,
    material,
    materialId,
    object,
    parametersTargetChanged,
    pendingOperations,
    refreshFailedAssignment,
    rebaseFailedAssignment,
    retryFailedAssignment,
    scene,
    setAnisotropyDraftState,
    setDraftState,
    setFeedback,
    updateAnisotropyDraft,
    updateCreateDraft,
    updateDraft,
  } as const;
}

type ObjectMaterialPanelState = ReturnType<typeof useObjectMaterialPanelState>;

function materialInspectorSections(selectionKind: string | null): string[] {
  switch (selectionKind) {
    case "object.material":
      return ["parameters", "material-parameters", "absorbing-boundary", "actions"];
    case "object.magnetic-parameters":
      return ["parameters", "assignment", "uniaxial-anisotropy", "absorbing-boundary", "actions"];
    default:
      return ["parameters", "assignment", "uniaxial-anisotropy", "material-parameters", "absorbing-boundary", "actions"];
  }
}

export function ObjectMaterialPanel({ selection }: InspectorPanelProps) {
  const panel = useObjectMaterialPanelState(selection);
  const sections = materialInspectorSections(selection.kind);
  const showSection = (section: string) => sections.includes(section);
  return <ObjectMaterialPanelView panel={panel} showSection={showSection} />;
}

function ObjectMaterialPanelView({
  panel,
  showSection,
}: {
  panel: ObjectMaterialPanelState;
  showSection: (section: string) => boolean;
}) {
  const {
    anisotropyDraft,
    applyAnisotropy,
    applyMaterial,
    applyParameters,
    assignmentFailure,
    baseAnisotropyDraft,
    baseDraft,
    createAndAssignMaterial,
    createDraft,
    draft,
    draftIdentityKey,
    draftKey,
    feedback,
    material,
    materialId,
    object,
    parametersTargetChanged,
    pendingOperations,
    refreshFailedAssignment,
    rebaseFailedAssignment,
    retryFailedAssignment,
    scene,
    setAnisotropyDraftState,
    setDraftState,
    setFeedback,
    updateAnisotropyDraft,
    updateCreateDraft,
    updateDraft,
  } = panel;
  const draftDirty = magneticParametersDraftDirty(draft, baseDraft);
  const parametersDirty = magneticParametersDraftDirty(
    { ...draft, materialRef: baseDraft.materialRef },
    baseDraft,
  );
  const anisotropyDirty = JSON.stringify(anisotropyDraft) !== JSON.stringify(baseAnisotropyDraft);
  const parametersValidation = buildMaterialParametersPatch(draft);
  const anisotropyValid = [
    anisotropyDraft.ku1,
    anisotropyDraft.axisX,
    anisotropyDraft.axisY,
    anisotropyDraft.axisZ,
  ].every((value) => Number.isFinite(Number(value)));
  const applyInspectorDraft = useCallback(async () => {
    if (parametersTargetChanged) {
      if (!(await applyMaterial())) return false;
      if (parametersDirty) {
        setFeedback({
          kind: "success",
          message: "Material assignment saved. Apply again after the assigned material loads to save its parameters.",
        });
        return false;
      }
    } else if (parametersDirty && !(await applyParameters())) {
      return false;
    }
    if (anisotropyDirty && !(await applyAnisotropy())) return false;
    return true;
  }, [
    anisotropyDirty,
    applyAnisotropy,
    applyMaterial,
    applyParameters,
    parametersDirty,
    parametersTargetChanged,
    setFeedback,
  ]);
  const resetInspectorDraft = useCallback(() => {
    setDraftState(
      initialInspectorDraftState({
        baseDraft,
        baseKey: draftKey,
        identityKey: draftIdentityKey,
      }),
    );
    setAnisotropyDraftState({ draft: baseAnisotropyDraft, key: "" });
    setFeedback(null);
  }, [
    baseAnisotropyDraft,
    baseDraft,
    draftIdentityKey,
    draftKey,
    setAnisotropyDraftState,
    setDraftState,
    setFeedback,
  ]);
  useRegisterInspectorEditSession(
    "staged",
    pendingOperations.has("assignment") ||
      pendingOperations.has("parameters") ||
      pendingOperations.has("anisotropy"),
    draftDirty || anisotropyDirty,
    !("error" in parametersValidation) && anisotropyValid,
    undefined,
    applyInspectorDraft,
    resetInspectorDraft,
  );
  return (
    <div className="fm-inspector-panel">
      <div className="grid min-w-0 gap-fm-inspector-group">
          {showSection("parameters") ? (
            <InspectorGroup title="Magnetic Parameters" collapsible defaultOpen>
              <FieldRow label="Object ID" value={object.objectId} />
              <FieldRow label="Current material" value={object.material} />
              <FieldRow
                label="Material resource"
                value={material.data?.name ?? materialId ?? "unassigned"}
              />
              <FieldRow label="Mode" value={object.mode} />
              <FieldRow
                label="Scene revision"
                value={object.baseRevision === null ? "unknown" : String(object.baseRevision)}
              />
              <FieldRow label="Scene fetch" value={scene.status} />
              <FieldRow label="Material fetch" value={material.status} />
            </InspectorGroup>
          ) : null}

          {showSection("assignment") ? (
            <InspectorGroup title="Assignment">
              <FormField
                label="Material"
                type="select"
                value={draft.materialRef}
                onChange={(event) => updateDraft({ materialRef: event.target.value })}
              >
                <option value="">Unassigned</option>
                {scene.data?.materials?.map((material) => (
                  <option key={material.id} value={material.id}>
                    {material.name} ({material.id})
                  </option>
                ))}
              </FormField>
              <FieldRow
                label="Selected"
                value={
                  scene.data?.materials?.find((material) => material.id === draft.materialRef)
                    ?.name ?? draft.materialRef ?? "unassigned"
                }
              />
            </InspectorGroup>
          ) : null}
          {showSection("assignment") ? (
            <InspectorGroup title="Create and Assign Material">
              <FormField
                label="New material name"
                mono={false}
                type="text"
                value={createDraft.name}
                onChange={(event) => updateCreateDraft({ name: event.target.value })}
              />
              <FormField
                label="New material ID"
                type="text"
                value={createDraft.materialId}
                onChange={(event) => updateCreateDraft({ materialId: event.target.value })}
              />
              <FormField
                label="New Ms"
                type="number"
                unit="A/m"
                value={createDraft.ms}
                onChange={(event) => updateCreateDraft({ ms: event.target.value })}
              />
              <FormField
                label="New A"
                type="number"
                unit="J/m"
                value={createDraft.aex}
                onChange={(event) => updateCreateDraft({ aex: event.target.value })}
              />
              <FormField
                label="New alpha"
                type="number"
                value={createDraft.alpha}
                onChange={(event) => updateCreateDraft({ alpha: event.target.value })}
              />
              <FormField
                label="New Ku1"
                hint="Optional interaction draft. It is not part of the material ACK and must be applied separately below."
                type="number"
                unit="J/m³"
                value={createDraft.ku1}
                onChange={(event) => updateCreateDraft({ ku1: event.target.value })}
              />
              <Vector3Field
                label="New anisotropy axis"
                disabled={!createDraft.ku1.trim()}
                values={[...createDraft.anisotropyAxis]}
                onChange={(index, value) => {
                  const axis = [...createDraft.anisotropyAxis] as [string, string, string];
                  axis[index] = value;
                  updateCreateDraft({ anisotropyAxis: axis });
                }}
              />
              <div className="fm-inspector-toolbar">
                <Button
                  disabled={pendingOperations.has("create-assign") || object.mode !== "committed"}
                  size="sm"
                  type="button"
                  variant="primary"
                  onClick={() => void createAndAssignMaterial()}
                >
                  Create and assign
                </Button>
              </div>
              {assignmentFailure ? (
                <div className="fm-inspector-toolbar" data-material-assignment-conflict="true">
                  <Button
                    disabled={pendingOperations.has("retry-assign")}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => void refreshFailedAssignment()}
                  >
                    Refresh scene
                  </Button>
                  <Button
                    disabled={
                      pendingOperations.has("retry-assign") ||
                      scene.status !== "ready" ||
                      !assignmentFailure.refreshCompleted ||
                      (scene.data?.revision ?? 0) <= assignmentFailure.error.assignmentBaseRevision
                    }
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={rebaseFailedAssignment}
                  >
                    Rebase assignment
                  </Button>
                  <Button
                    disabled={pendingOperations.has("retry-assign") || assignmentFailure.rebasedRevision === null}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => void retryFailedAssignment()}
                  >
                    Retry assignment
                  </Button>
                </div>
              ) : null}
            </InspectorGroup>
          ) : null}
      </div>

      <div className="grid min-w-0 gap-fm-inspector-group">
          {showSection("material-parameters") ? (
            <InspectorGroup title="Material Parameters">
              <FormField
                label="Name"
                mono={false}
                type="text"
                disabled={!material.data}
                value={draft.materialName}
                onChange={(event) => updateDraft({ materialName: event.target.value })}
              />
              <FormField
                label="Ms"
                type="number"
                unit="A/m"
                disabled={!material.data}
                value={draft.ms}
                onChange={(event) => updateDraft({ ms: event.target.value })}
              />
              <FormField
                label="Aex"
                type="number"
                unit="J/m"
                disabled={!material.data}
                value={draft.aex}
                onChange={(event) => updateDraft({ aex: event.target.value })}
              />
              <FormField
                label="alpha"
                type="number"
                disabled={!material.data}
                value={draft.alpha}
                onChange={(event) => updateDraft({ alpha: event.target.value })}
              />
              <FormField
                label="Dind"
                type="number"
                unit="J/m²"
                disabled={!material.data}
                value={draft.dind}
                onChange={(event) => updateDraft({ dind: event.target.value })}
              />
              <FormField
                label="Dbulk"
                type="number"
                unit="J/m²"
                disabled={!material.data}
                value={draft.dbulk}
                onChange={(event) => updateDraft({ dbulk: event.target.value })}
              />
            </InspectorGroup>
          ) : null}

          {showSection("absorbing-boundary") && object.mode === "committed" ? (
            <ObjectAbsorbingBoundaryPanel
              objectId={object.objectId}
              baseRevision={object.baseRevision}
            />
          ) : null}

          {showSection("uniaxial-anisotropy") ? (
            <InspectorGroup title="Uniaxial Anisotropy">
              <FormField
                label="Present"
                type="checkbox"
                checked={anisotropyDraft.present}
                onChange={(event) =>
                  updateAnisotropyDraft({ present: (event.target as HTMLInputElement).checked })
                }
              />
              <FormField
                label="Ku1"
                type="number"
                unit="J/m³"
                disabled={!anisotropyDraft.present}
                value={anisotropyDraft.ku1}
                onChange={(event) => updateAnisotropyDraft({ ku1: event.target.value })}
              />
              <Vector3Field
                label="Axis"
                disabled={!anisotropyDraft.present}
                values={[anisotropyDraft.axisX, anisotropyDraft.axisY, anisotropyDraft.axisZ]}
                onChange={(index, value) => {
                  const fields = ["axisX", "axisY", "axisZ"] as const;
                  updateAnisotropyDraft({ [fields[index]]: value });
                }}
              />
            </InspectorGroup>
          ) : null}
      </div>

      <div className="grid min-w-0 gap-fm-inspector-group">
          {showSection("actions") ? (
            <InspectorGroup title="Actions">
              <div className="fm-inspector-toolbar">
                {showSection("assignment") ? (
                  <Button
                    disabled={pendingOperations.has("assignment") || object.mode !== "committed"}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => void applyMaterial()}
                  >
                    Apply Assignment
                  </Button>
                ) : null}
                {showSection("material-parameters") ? (
                  <Button
                    disabled={pendingOperations.has("parameters") || !material.data || parametersTargetChanged}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => void applyParameters()}
                  >
                    Apply Parameters
                  </Button>
                ) : null}
                {showSection("uniaxial-anisotropy") ? (
                  <Button
                    disabled={pendingOperations.has("anisotropy") || object.mode !== "committed"}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => void applyAnisotropy()}
                  >
                    Apply Anisotropy
                  </Button>
                ) : null}
                <Button
                  disabled={
                    pendingOperations.has("assignment") ||
                    pendingOperations.has("parameters") ||
                    pendingOperations.has("anisotropy")
                  }
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setDraftState(
                      initialInspectorDraftState({
                        baseDraft,
                        baseKey: draftKey,
                        identityKey: draftIdentityKey,
                      }),
                    );
                    setAnisotropyDraftState({ draft: baseAnisotropyDraft, key: "" });
                    setFeedback(null);
                  }}
                >
                  Revert
                </Button>
              </div>
              {feedback && <FeedbackBanner kind={feedback.kind} message={feedback.message} />}
            </InspectorGroup>
          ) : null}
      </div>
    </div>
  );
}
