"use client";

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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
  ABSORBING_BOUNDARY_FACES,
  ABSORBING_BOUNDARY_FRAMES,
  ABSORBING_BOUNDARY_PROFILES,
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
  const draft = draftState.key === baseKey ? draftState.draft : effectiveBaseDraft;
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
    setDraftState({ key: baseKey, draft: next });
  };
  const dirty =
    absorbingBoundaryDraftKey(draft) !==
    absorbingBoundaryDraftKey(effectiveBaseDraft);
  const validation = buildAbsorbingBoundaryPatch(draft, baseRevision);
  const fieldError = (field: keyof AbsorbingBoundaryDraft) =>
    dirty && "error" in validation && validation.field === field ? validation.error : undefined;
  const editable = object !== null && (view === "activation" || effectiveBaseDraft.enabled);
  const valid = editable && baseRevision !== null && !("error" in validation);

  const acknowledgeAppliedDraft = useRegisterInspectorEditSession(
    editable ? "staged" : null,
    pending || mutationBusy,
    dirty,
    valid,
    undefined,
    apply,
    resetDraft,
    {
      applyBlockReason:
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

  const toggleFace = (face: string) =>
    update({
      faces: draft.faces.includes(face)
        ? draft.faces.filter((current) => current !== face)
        : [...draft.faces, face],
    });

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
    if (applyInFlight.current || !editable || !dirty) return false;
    const submittedDraft = draft;
    const result = buildAbsorbingBoundaryPatch(submittedDraft, baseRevision);
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
          if (before && capturedRevision !== baseRevision) {
            const current = before.objects?.find((candidate) => candidate.id === objectId);
            const currentKey = absorbingBoundaryDraftKey(absorbingBoundaryDraftFromObject(current));
            if (!current || currentKey !== absorbingBoundaryDraftKey(effectiveBaseDraft)) {
              throw new Error("Absorbing boundary changed. Refresh the scene before applying your draft.");
            }
          }
          const next = buildAbsorbingBoundaryPatch(
            submittedDraft,
            commitRevision,
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
      const rebasedDraft = { ...acknowledgedDraft };
      for (const field of Object.keys(submittedDraft) as (keyof AbsorbingBoundaryDraft)[]) {
        if (latestDraft[field] !== submittedDraft[field]) {
          Object.assign(rebasedDraft, { [field]: latestDraft[field] });
        }
      }
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

  const feedbackBanner = feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null;
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
    <InspectorGroup title="Absorbing Boundary" description="Adds object-owned Gilbert damping toward selected faces.">
      <FormField
        label="Total width"
        error={fieldError("totalWidth")}
        type="number"
        unit="m"
        value={draft.totalWidth}
        onChange={(event) => update({ totalWidth: event.target.value })}
      />
      <FormField
        label="Ramp width"
        error={fieldError("rampWidth")}
        type="number"
        unit="m"
        value={draft.rampWidth}
        onChange={(event) => update({ rampWidth: event.target.value })}
      />
      <FormField
        label="Maximum damping"
        error={fieldError("maxDamping")}
        type="number"
        value={draft.maxDamping}
        onChange={(event) => update({ maxDamping: event.target.value })}
      />
      <FormField
        label="Profile"
        error={fieldError("profile")}
        type="select"
        value={draft.profile}
        onChange={(event) => update({ profile: event.target.value })}
      >
        {ABSORBING_BOUNDARY_PROFILES.map((profile) => (
          <option key={profile} value={profile}>{profile}</option>
        ))}
      </FormField>
      {draft.profile === "custom" ? (
        <FormField
          label="Expression"
          error={fieldError("expression")}
          type="text"
          mono
          value={draft.expression}
          maxLength={256}
          placeholder="u**3"
          hint="u runs from 0 at the start of the ramp to 1 at the plateau."
          help="Use u, decimal numbers, +, -, *, /, **, parentheses, and abs, sqrt, exp, log, log1p, tanh, sin, or cos. The result must stay in [0, 1] and equal 0 and 1 at the respective endpoints."
          onChange={(event) => update({ expression: event.target.value })}
        />
      ) : null}
      <FormField
        label="Frame"
        error={fieldError("frame")}
        type="select"
        value={draft.frame}
        onChange={(event) => update({ frame: event.target.value })}
      >
        {ABSORBING_BOUNDARY_FRAMES.map((frame) => (
          <option key={frame} value={frame}>{frame}</option>
        ))}
      </FormField>
      <div className="grid gap-fm-inspector-control">
        <span className="text-fm-xs font-medium text-fm-secondary">Faces</span>
        {ABSORBING_BOUNDARY_FACES.map((face) => (
          <FormField
            key={face}
            label={face}
            error={face === ABSORBING_BOUNDARY_FACES[0] ? fieldError("faces") : undefined}
            type="checkbox"
            checked={draft.faces.includes(face)}
            onChange={() => toggleFace(face)}
          />
        ))}
      </div>
      {feedbackBanner}
    </InspectorGroup>
  );
}
