"use client";

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/shared/ui/Button";
import { SpatialAbsorbingLayerEditor } from "./SpatialAbsorbingLayerEditor";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { SCENE_RESOURCE_KEY, useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { useKernel } from "@/kernel/KernelContext";

import type { InspectorPanelProps } from "../inspectorTypes";
import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { DedicatedInspectorRouteFrame } from "./DedicatedInspectorRouteFrame";
import { sceneResourceRevision } from "./ObjectMaterialPanelModel";
import {
  createLayerDraft,
  rebaseAbsorbingBoundaryDraft,
  type LayerDraft,
  absorbingBoundaryDraftFromObject,
  absorbingBoundaryDraftKey,
  buildAbsorbingBoundaryPatch,
  type AbsorbingBoundaryDraft,
} from "./ObjectAbsorbingBoundaryPanelModel";
import {
  objectMaterialMutationCoordinator,
  objectMaterialMutationScopeKey,
  type ObjectMaterialMutationCoordinator,
} from "./ObjectMaterialPanelEditSession";

interface ObjectAbsorbingBoundaryPanelProps {
  objectId: string;
  scene: SceneResource | null;
  view: "activation" | "editor";
  mutationCoordinator?: ObjectMaterialMutationCoordinator;
  sessionScopeKey: string | null;
}

type Feedback = { kind: "error" | "success"; message: string } | null;

export function ObjectAbsorbingBoundaryInspectorPanel({ selection }: InspectorPanelProps) {
  const scene = useSceneResource();
  const objectId = selection.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection.objectId;
  const scopeKey = objectMaterialMutationScopeKey(scene.sessionScopeKey ?? null, objectId ?? "");
  return (
    <DedicatedInspectorRouteFrame owner="object.absorbing-boundary" selection={selection}>
      <ObjectAbsorbingBoundaryPanel
        key={scopeKey}
        objectId={objectId ?? ""}
        scene={scene.data}
        view="editor"
        sessionScopeKey={scene.sessionScopeKey}
      />
    </DedicatedInspectorRouteFrame>
  );
}

export function ObjectAbsorbingBoundaryPanel({
  objectId,
  scene,
  view,
  mutationCoordinator: sharedMutationCoordinator,
  sessionScopeKey,
}: ObjectAbsorbingBoundaryPanelProps) {
  const { api, authoringHistory, commands, resources } = useKernel();
  const baseRevision = sceneResourceRevision(scene);
  const mutationScopeKey = objectMaterialMutationScopeKey(sessionScopeKey, objectId);
  const historyGeneration = authoringHistory?.getGeneration?.();
  const object = useMemo(
    () => scene?.objects?.find((candidate) => candidate.id === objectId) ?? null,
    [objectId, scene?.objects],
  );
  const regions = (object?.regions ?? []).flatMap(region => region.region_id ? [{
    id: region.region_id,
    label: (region.name && region.name !== region.region_id ? region.name + " (" + region.region_id + ")" : region.region_id)
      + (region.enabled === false ? " (disabled)" : ""),
  }] : []);
  const regionIds = regions.map(region => region.id);
  const baseDraft = useMemo(
    () => absorbingBoundaryDraftFromObject(object),
    [object],
  );
  const [acknowledgedBase, setAcknowledgedBase] = useState<{
    draft: AbsorbingBoundaryDraft;
    objectId: string;
    revision: number;
  } | null>(null);
  const resourceRevision = baseRevision ?? -1;
  const hasPendingAcknowledgedBase =
    acknowledgedBase?.objectId === objectId &&
    resourceRevision < acknowledgedBase.revision;
  const effectiveBaseDraft = hasPendingAcknowledgedBase
    ? acknowledgedBase.draft
    : baseDraft;
  const baseKey = `${objectId}:${absorbingBoundaryDraftKey(effectiveBaseDraft)}`;
  const [draftState, setDraftState] = useState<{ key: string; draft: AbsorbingBoundaryDraft }>({
    key: baseKey,
    draft: effectiveBaseDraft,
  });
  const localKey = objectId + ":" + absorbingBoundaryDraftKey(draftState.draft);
  const conflict = effectiveBaseDraft.enabled && draftState.key !== localKey &&
    draftState.key !== baseKey && localKey !== baseKey;
  const conflictMessage = "The absorbing boundary changed in another edit. Revert to load its saved layers before applying.";
  const draft = draftState.key === baseKey || conflict ? draftState.draft : effectiveBaseDraft;
  const draftRef = useRef(draft);
  useLayoutEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const [pending, setPending] = useState(false);
  const applyInFlight = useRef(false);
  const mutationCoordinator = sharedMutationCoordinator ?? objectMaterialMutationCoordinator;
  useSyncExternalStore(
    mutationCoordinator.subscribe,
    mutationCoordinator.getVersion,
    mutationCoordinator.getVersion,
  );
  const mutationBusy = mutationCoordinator.getActive(mutationScopeKey) !== null;
  const [feedback, setFeedback] = useState<Feedback>(null);
  const update = (patch: Partial<AbsorbingBoundaryDraft>) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraftState({ key: conflict ? draftState.key : baseKey, draft: next });
  };
  const dirty =
    absorbingBoundaryDraftKey(draft) !==
    absorbingBoundaryDraftKey(effectiveBaseDraft);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = draft.layers.find(layer => layer.id === selectedId) ?? draft.layers[0];
  const validation = buildAbsorbingBoundaryPatch(draft, baseRevision, regionIds);
  const fieldError = (field: keyof LayerDraft) =>
    dirty && "error" in validation && validation.layerId === selected?.id && validation.field === field
      ? validation.error : undefined;
  const editable = object !== null && (view === "activation" || effectiveBaseDraft.enabled);
  const valid = editable && !conflict && baseRevision !== null && !("error" in validation);

  const acknowledgeAppliedDraft = useRegisterInspectorEditSession(
    editable ? "staged" : null,
    pending || mutationBusy,
    dirty,
    valid,
    undefined,
    apply,
    resetDraft,
    {
      applyBlockReason: conflict ? conflictMessage :
        object && baseRevision === null
          ? "The canonical scene revision is unavailable. Refetch the scene before applying."
          : dirty && "error" in validation ? validation.error : undefined,
      historyMode: "mutation-owned",
    },
  );

  function createHistoryMutationContext() {
    return {
      api,
      authoringHistory,
      resourceData: { [SCENE_RESOURCE_KEY]: scene },
      sessionScopeKey,
      isCurrentSessionScope: () =>
        commands.getSessionScopeKey() === sessionScopeKey &&
        (historyGeneration === undefined ||
          authoringHistory?.getGeneration?.() === historyGeneration),
    };
  }

  function updateLayer(patch: Partial<LayerDraft>) {
    if (!selected) return;
    const layers = draftRef.current.layers.map(layer => layer.id === selected.id ? { ...layer, ...patch } : layer);
    const needsCollection = Boolean(patch.name !== undefined || patch.enabled !== undefined ||
      patch.region !== undefined || (patch.kind && patch.kind !== "faces"));
    update({ layers, legacy: draft.legacy && !needsCollection });
  }

  function addLayer(copy?: LayerDraft) {
    const id = crypto.randomUUID();
    const layer = copy ? { ...copy, id, name: copy.name + " copy" }
      : createLayerDraft(id, "Layer " + (draft.layers.length + 1));
    update({ enabled: true, legacy: false, layers: [...draftRef.current.layers, layer] });
    setSelectedId(id);
  }

  function removeLayer(id: string) {
    const layers = draftRef.current.layers.filter(layer => layer.id !== id);
    update({ enabled: layers.length > 0, legacy: false, layers });
    setSelectedId(layers[0]?.id ?? null);
  }

  function resetDraft(): void {
    const active = mutationCoordinator.getActive(mutationScopeKey);
    if (active) {
      setFeedback({
        kind: "error",
        message: `${active.operation} is still saving. Wait for its acknowledgement before reverting.`,
      });
      return;
    }
    draftRef.current = effectiveBaseDraft;
    setDraftState({ key: baseKey, draft: effectiveBaseDraft });
    setFeedback(null);
  }

  async function apply(): Promise<boolean> {
    if (applyInFlight.current || !editable || !dirty || conflict) return false;
    const submittedDraft = draft;
    const result = buildAbsorbingBoundaryPatch(submittedDraft, baseRevision, regionIds);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return false;
    }
    const historyContext = createHistoryMutationContext();
    if (!historyContext.sessionScopeKey || !commands.getSessionScopeKey()) {
      setFeedback({ kind: "error", message: "Session identity is not ready. Try again after it loads." });
      return false;
    }
    if (!historyContext.isCurrentSessionScope()) {
      setFeedback({ kind: "error", message: "The active session changed. Reopen the absorbing boundary before applying." });
      return false;
    }
    const mutationLease = mutationCoordinator.acquire(
      mutationScopeKey,
      "Absorbing boundary",
    );
    if (!mutationLease) {
      const active = mutationCoordinator.getActive(mutationScopeKey);
      setFeedback({
        kind: "error",
        message: active
          ? `${active.operation} is still saving. Wait for its acknowledgement before starting another update.`
          : "Another update is still saving. Wait for its acknowledgement before trying again.",
      });
      return false;
    }
    applyInFlight.current = true;
    setPending(true);
    try {
      const response = await runAuthoringMutationWithHistory(
        historyContext,
        `Update absorbing boundary ${objectId}`,
        async ({ before, baseRevision: capturedRevision }) => {
          const commitRevision = capturedRevision ?? baseRevision;
          if (typeof commitRevision !== "number" || !Number.isFinite(commitRevision)) {
            throw new Error("The canonical scene revision is unavailable. Refetch the scene before applying.");
          }
          let commitRegionIds = regionIds;
          if (before && capturedRevision !== baseRevision) {
            const current = before.objects?.find((candidate) => candidate.id === objectId);
            const currentKey = absorbingBoundaryDraftKey(absorbingBoundaryDraftFromObject(current));
            if (!current || currentKey !== absorbingBoundaryDraftKey(effectiveBaseDraft)) {
              throw new Error("Absorbing boundary changed. Refresh the scene before applying your draft.");
            }
            commitRegionIds = (current.regions ?? []).flatMap(region => region.region_id ? [region.region_id] : []);
          }
          const next = buildAbsorbingBoundaryPatch(
            submittedDraft,
            commitRevision,
            commitRegionIds,
          );
          if ("error" in next) throw new Error(next.error);
          return api.model.patchObject(
            objectId,
            next.patch,
            authoringWriteOptions(commitRevision, historyContext.sessionScopeKey),
          );
        },
      );
      if (historyContext.isCurrentSessionScope() === false) return false;
      const revision = typeof response.revision === "number" ? response.revision : (baseRevision ?? 0) + 1;
      const savedObject = response.objects?.find((candidate) => candidate.id === objectId);
      const acknowledgedDraft = absorbingBoundaryDraftFromObject(savedObject ?? result.patch);
      setAcknowledgedBase({ objectId, revision, draft: acknowledgedDraft });
      const latestDraft = draftRef.current;
      const rebasedDraft = rebaseAbsorbingBoundaryDraft(acknowledgedDraft, submittedDraft, latestDraft);
      draftRef.current = rebasedDraft;
      setDraftState({
        key: `${objectId}:${absorbingBoundaryDraftKey(acknowledgedDraft)}`,
        draft: rebasedDraft,
      });
      invalidateAuthoringMutationDependents(resources, "material", revision);
      if (latestDraft === submittedDraft && !acknowledgeAppliedDraft()) return false;
      setFeedback({ kind: "success", message: "Absorbing boundary updated." });
      return true;
    } catch (error) {
      if (historyContext.isCurrentSessionScope() === false) return false;
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      applyInFlight.current = false;
      setPending(false);
      mutationCoordinator.finish(mutationLease);
    }
  }

  const feedbackBanner = conflict ? <FeedbackBanner kind="error" message={conflictMessage} /> : feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null;
  if (view === "activation") {
    return (
      <>
        <FormField
          label="Absorbing Boundary"
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        {feedbackBanner}
      </>
    );
  }

  if (!editable) {
    return <p>{scene ? "No absorbing boundary is active for this object." : "Loading absorbing boundary…"}</p>;
  }

  return (
    <InspectorGroup title="Absorbing Boundary">
      {draft.layers.length > 0 && (
        <FormField label="Layer" type="select" value={selected?.id ?? ""} onChange={event => setSelectedId(event.target.value)}>
          {draft.layers.map(layer => <option key={layer.id} value={layer.id}>
            {layer.name || "Unnamed layer"}{layer.enabled ? "" : " (disabled)"}
          </option>)}
        </FormField>
      )}
      <div className="flex flex-wrap gap-1">
        <Button type="button" variant="secondary" onClick={() => addLayer()}>Add layer</Button>
        {selected && <>
          <Button type="button" variant="ghost" onClick={() => addLayer(selected)}>Duplicate layer</Button>
          <Button type="button" variant="ghost" onClick={() => removeLayer(selected.id)}>Remove layer</Button>
        </>}
      </div>
      {selected ? <SpatialAbsorbingLayerEditor draft={selected} update={updateLayer} fieldError={fieldError} regions={regions} />
        : <p>Apply to remove the absorbing boundary, or add another layer.</p>}
      {dirty && "error" in validation && validation.layerId !== selected?.id && (
        <FeedbackBanner kind="error" message={(draft.layers.find(layer => layer.id === validation.layerId)?.name ?? "Layer") + " — " + validation.error} />
      )}
      {feedbackBanner}
    </InspectorGroup>
  );
}
