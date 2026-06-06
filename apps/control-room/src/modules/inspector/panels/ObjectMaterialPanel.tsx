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
import { Accordion } from "@/shared/ui/Accordion";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import { Vector3Field } from "../primitives/Vector3Field";
import { resolveGeometryObjectDraft } from "./geometryObjectPanelModel";
import {
  buildMaterialAssignmentPatch,
  buildMaterialParametersPatch,
  magneticParametersDraftFromResource,
  materialParametersDraftKey,
  normalizeMaterialRef,
  type MagneticParametersDraft,
} from "./ObjectMaterialPanelModel";

interface DraftState {
  draft: MagneticParametersDraft;
  key: string;
}

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
  const [draftState, setDraftState] = useState<DraftState>({
    draft: baseDraft,
    key: draftKey,
  });
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState(false);
  const draft = draftState.key === draftKey ? draftState.draft : baseDraft;
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

  async function applyAnisotropy(): Promise<void> {
    if (!object.objectId || object.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
    }
    const ku1 = Number(anisotropyDraft.ku1);
    if (!Number.isFinite(ku1)) {
      setFeedback({ kind: "error", message: "Ku1 must be a finite number." });
      return;
    }
    const axisX = Number(anisotropyDraft.axisX);
    const axisY = Number(anisotropyDraft.axisY);
    const axisZ = Number(anisotropyDraft.axisZ);
    if (!Number.isFinite(axisX) || !Number.isFinite(axisY) || !Number.isFinite(axisZ)) {
      setFeedback({ kind: "error", message: "Anisotropy axis components must be finite numbers." });
      return;
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
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  function updateDraft(patch: Partial<MagneticParametersDraft>): void {
    setDraftState((current) => ({
      draft: {
        ...(current.key === draftKey ? current.draft : baseDraft),
        ...patch,
      },
      key: draftKey,
    }));
  }

  async function applyMaterial(): Promise<void> {
    if (object.mode !== "committed") {
      setFeedback({ kind: "error", message: "No committed scene object." });
      return;
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
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  async function applyParameters(): Promise<void> {
    if (!materialId || !material.data) {
      setFeedback({
        kind: "error",
        message: "No committed material asset is assigned to this object.",
      });
      return;
    }
    if (parametersTargetChanged) {
      setFeedback({
        kind: "error",
        message: "Apply the material assignment before editing its parameters.",
      });
      return;
    }

    const result = buildMaterialParametersPatch(draft);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return;
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
    } catch (error) {
      setFeedback({ kind: "error", message: errorMessage(error) });
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
  return <ObjectMaterialPanelView panel={panel} sections={sections} showSection={showSection} selectionKind={selection.kind} />;
}

function ObjectMaterialPanelView({
  panel,
  sections,
  showSection,
  selectionKind,
}: {
  panel: ObjectMaterialPanelState;
  sections: string[];
  showSection: (section: string) => boolean;
  selectionKind: string | null;
}) {
  const {
    anisotropyDraft,
    applyAnisotropy,
    applyMaterial,
    applyParameters,
    baseAnisotropyDraft,
    baseDraft,
    draft,
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

  return (
    <Accordion
      key={selectionKind ?? "default"}
      className="fm-inspector-panel"
      type="multiple"
      defaultValue={sections}
    >
      {showSection("parameters") ? (
        <InspectorSection value="parameters" title="Magnetic Parameters" collapsible defaultCollapsed={false}>
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
        <InspectorSection value="assignment" title="Assignment">
          <FormField
            label="Material ref"
            mono={false}
            type="text"
            value={draft.materialRef}
            onChange={(event) => updateDraft({ materialRef: event.target.value })}
          />
        </InspectorSection>
      ) : null}

      {showSection("uniaxial-anisotropy") ? (
        <InspectorSection value="uniaxial-anisotropy" title="Uniaxial Anisotropy">
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

      {showSection("material-parameters") ? (
        <InspectorSection value="material-parameters" title="Material Parameters">
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

      {showSection("actions") ? (
        <InspectorSection value="actions" title="Actions">
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
                setDraftState({ draft: baseDraft, key: draftKey });
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
    </Accordion>
  );
}
