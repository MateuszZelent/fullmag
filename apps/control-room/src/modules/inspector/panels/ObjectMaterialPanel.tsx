"use client";

import { useMemo, useState } from "react";

import {
  MODEL_GEOMETRY_DIAGNOSTICS_PATH,
  MODEL_GEOMETRY_VALIDATION_PATH,
} from "@/kernel/api/apiPaths";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_BUILD_CURRENT_RESOURCE_KEY,
  MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY,
  resolveMaterialResourceKey,
  resolveObjectInteractionResourceKey,
  SCENE_RESOURCE_KEY,
  useMaterialResource,
  useObjectInteractionResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { Tabs, TabsContent } from "@/shared/ui/Tabs";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { useInspectorActiveTab } from "../InspectorTabState";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import { Vector3Field } from "../primitives/Vector3Field";
import {
  initialInspectorDraftState,
  resolveInspectorDraftState,
  updateInspectorDraftState,
  type InspectorDraftState,
} from "./inspectorDraftState";
import { resolveGeometryObjectDraft } from "./geometryObjectPanelModel";
import {
  buildMaterialAssignmentPatch,
  buildMaterialParametersPatch,
  magneticParametersDraftFromResource,
  magneticParametersDraftDirty,
  materialParametersDraftKey,
  normalizeMaterialRef,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextLocalRevision(
  ...revisions: Array<number | string | null | undefined>
): number {
  const numericRevisions = revisions.filter(
    (revision): revision is number =>
      typeof revision === "number" && Number.isFinite(revision),
  );
  return numericRevisions.length > 0 ? Math.max(...numericRevisions) + 1 : 0;
}

function resolveMutationRevision(
  value: unknown,
  ...fallbacks: Array<number | string | null | undefined>
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : nextLocalRevision(...fallbacks);
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
  const [pending, setPending] = useState(false);
  const { draft } = resolveInspectorDraftState({
    baseDraft,
    baseKey: draftKey,
    identityKey: draftIdentityKey,
    isDirty: magneticParametersDraftDirty,
    state: draftState,
  });
  const draftMaterialId = normalizeMaterialRef(draft.materialRef);
  const parametersTargetChanged = draftMaterialId !== materialId;

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
    const ku1 = Number(anisotropyDraft.ku1);
    if (!Number.isFinite(ku1)) {
      setFeedback({ kind: "error", message: "Ku1 must be a finite number." });
      return false;
    }
    const axisX = Number(anisotropyDraft.axisX);
    const axisY = Number(anisotropyDraft.axisY);
    const axisZ = Number(anisotropyDraft.axisZ);
    if (!Number.isFinite(axisX) || !Number.isFinite(axisY) || !Number.isFinite(axisZ)) {
      setFeedback({ kind: "error", message: "Anisotropy axis components must be finite numbers." });
      return false;
    }
    setPending(true);
    try {
      await api.model.patchObjectInteraction(object.objectId, "uniaxial_anisotropy", {
        present: anisotropyDraft.present,
        params: { ku1, axis: [axisX, axisY, axisZ] },
      });
      const revision = nextLocalRevision(object.baseRevision);
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
      setPending(false);
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

    setPending(true);
    try {
      const sceneResponse = await api.model.patchObject(
        object.objectId,
        buildMaterialAssignmentPatch(draft, object.baseRevision),
      );
      const revision = resolveMutationRevision(
        sceneResponse.revision,
        object.baseRevision,
      );
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
      setPending(false);
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

    setPending(true);
    try {
      await api.model.patchMaterial(materialId, result.patch);
      const revision = nextLocalRevision(material.revision, object.baseRevision);
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
      setPending(false);
    }
  }

  function invalidateMagneticParameterResources(revision: number): void {
    resources.invalidate(SCENE_RESOURCE_KEY, revision);
    resources.invalidate(MODEL_GEOMETRY_VALIDATION_PATH, revision);
    resources.invalidate(MODEL_GEOMETRY_DIAGNOSTICS_PATH, revision);
    resources.invalidate(MESH_BUILD_CURRENT_RESOURCE_KEY, revision);
    resources.invalidate(MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY, revision);
  }

  return {
    anisotropyDraft,
    applyAnisotropy,
    applyMaterial,
    applyParameters,
    baseAnisotropyDraft,
    baseDraft,
    draft,
    draftIdentityKey,
    draftKey,
    feedback,
    material,
    materialId,
    object,
    parametersTargetChanged,
    pending,
    scene,
    setAnisotropyDraftState,
    setDraftState,
    setFeedback,
    updateAnisotropyDraft,
    updateDraft,
  } as const;
}

type ObjectMaterialPanelState = ReturnType<typeof useObjectMaterialPanelState>;

function materialInspectorSections(selectionKind: string | null): string[] {
  switch (selectionKind) {
    case "object.material":
      return ["parameters", "material-parameters", "actions"];
    case "object.magnetic-parameters":
      return ["parameters", "assignment", "uniaxial-anisotropy", "actions"];
    default:
      return ["parameters", "assignment", "uniaxial-anisotropy", "material-parameters", "actions"];
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
    baseAnisotropyDraft,
    baseDraft,
    draft,
    draftIdentityKey,
    draftKey,
    feedback,
    material,
    materialId,
    object,
    parametersTargetChanged,
    pending,
    scene,
    setAnisotropyDraftState,
    setDraftState,
    setFeedback,
    updateAnisotropyDraft,
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
  useRegisterInspectorEditSession(
    "staged",
    pending,
    draftDirty || anisotropyDirty,
    !("error" in parametersValidation) && anisotropyValid,
    undefined,
    async () => {
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
    },
    () => {
      setDraftState(
        initialInspectorDraftState({
          baseDraft,
          baseKey: draftKey,
          identityKey: draftIdentityKey,
        }),
      );
      setAnisotropyDraftState({ draft: baseAnisotropyDraft, key: "" });
      setFeedback(null);
    },
  );
  const activeTab = useInspectorActiveTab();

  return (
    <div className="fm-inspector-panel">
      <Tabs value={activeTab} className="fm-inspector-tabs">

        <TabsContent value="overview" className="fm-tabs-content">
          {showSection("parameters") ? (
            <InspectorSection title="Magnetic Parameters" collapsible defaultCollapsed={false}>
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
            </InspectorSection>
          ) : null}

          {showSection("assignment") ? (
            <InspectorSection title="Assignment">
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
            </InspectorSection>
          ) : null}
        </TabsContent>

        <TabsContent value="properties" className="fm-tabs-content">
          {showSection("material-parameters") ? (
            <InspectorSection title="Material Parameters">
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
                unit="J/m³"
                disabled={!material.data}
                value={draft.dbulk}
                onChange={(event) => updateDraft({ dbulk: event.target.value })}
              />
            </InspectorSection>
          ) : null}

          {showSection("uniaxial-anisotropy") ? (
            <InspectorSection title="Uniaxial Anisotropy">
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
            </InspectorSection>
          ) : null}
        </TabsContent>

        <TabsContent value="diagnostics" className="fm-tabs-content">
          {showSection("actions") ? (
            <InspectorSection title="Actions">
              <div className="fm-inspector-toolbar">
                {showSection("assignment") ? (
                  <Button
                    disabled={pending || object.mode !== "committed"}
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
                    disabled={pending || !material.data || parametersTargetChanged}
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
                    disabled={pending || object.mode !== "committed"}
                    size="sm"
                    type="button"
                    variant="primary"
                    onClick={() => void applyAnisotropy()}
                  >
                    Apply Anisotropy
                  </Button>
                ) : null}
                <Button
                  disabled={pending}
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
            </InspectorSection>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
