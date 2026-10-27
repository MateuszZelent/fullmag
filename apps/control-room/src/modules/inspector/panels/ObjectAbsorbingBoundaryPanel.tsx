"use client";

import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { SCENE_RESOURCE_KEY, useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../InspectorEditSession";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
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
  type ObjectMaterialMutationCoordinator,
} from "./ObjectMaterialPanelEditSession";

interface ObjectAbsorbingBoundaryPanelProps {
  objectId: string;
  baseRevision: number | null;
  mutationCoordinator?: ObjectMaterialMutationCoordinator;
  mutationScopeKey?: string;
}

type Feedback = { kind: "error" | "success"; message: string } | null;

export function ObjectAbsorbingBoundaryPanel({
  objectId,
  baseRevision,
  mutationCoordinator: sharedMutationCoordinator,
  mutationScopeKey,
}: ObjectAbsorbingBoundaryPanelProps) {
  const { api, authoringHistory, commands, resources } = useKernel();
  const scene = useSceneResource();
  const object = useMemo(
    () => scene.data?.objects?.find((candidate) => candidate.id === objectId) ?? null,
    [objectId, scene.data?.objects],
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
  const resourceRevision = scene.data?.revision ?? baseRevision ?? -1;
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
  const objectMutationScopeKey = mutationScopeKey ?? `session:unknown|${objectId}`;
  const mutationBusy = mutationCoordinator.getActive(objectMutationScopeKey) !== null;
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
  const valid = object !== null && baseRevision !== null && !("error" in validation);

  const acknowledgeAppliedDraft = useRegisterInspectorEditSession(
    object ? "staged" : null,
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
          : undefined,
      historyMode: "mutation-owned",
    },
  );

  function createHistoryMutationContext() {
    const sessionScopeKey = commands.getSessionScopeKey();
    const historyGeneration = authoringHistory?.getGeneration?.();
    return {
      api,
      authoringHistory,
      resourceData: { [SCENE_RESOURCE_KEY]: scene.data },
      sessionScopeKey: sessionScopeKey ?? null,
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
    const active = mutationCoordinator.getActive(objectMutationScopeKey);
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
    if (applyInFlight.current) return false;
    if (!object) {
      setFeedback({ kind: "error", message: "The selected object is not available." });
      return false;
    }
    const submittedDraft = draft;
    const result = buildAbsorbingBoundaryPatch(submittedDraft, baseRevision);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return false;
    }
    const historyContext = createHistoryMutationContext();
    if (!historyContext.sessionScopeKey) {
      setFeedback({ kind: "error", message: "Session identity is not ready. Try again after it loads." });
      return false;
    }
    const mutationLease = mutationCoordinator.acquire(
      objectMutationScopeKey,
      "Absorbing boundary",
    );
    if (!mutationLease) {
      const active = mutationCoordinator.getActive(objectMutationScopeKey);
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
        async ({ baseRevision: capturedRevision }) => {
          const commitRevision = capturedRevision ?? baseRevision;
          if (typeof commitRevision !== "number" || !Number.isFinite(commitRevision)) {
            throw new Error("The canonical scene revision is unavailable. Refetch the scene before applying.");
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
      const acknowledgedDraft = { ...submittedDraft };
      setAcknowledgedBase({ objectId, revision, draft: acknowledgedDraft });
      const latestDraft = draftRef.current;
      const rebasedDraft = latestDraft === submittedDraft
        ? acknowledgedDraft
        : latestDraft;
      draftRef.current = rebasedDraft;
      setDraftState({
        key: `${objectId}:${absorbingBoundaryDraftKey(acknowledgedDraft)}`,
        draft: rebasedDraft,
      });
      if (latestDraft === submittedDraft && !acknowledgeAppliedDraft()) return false;
      resources.invalidate(SCENE_RESOURCE_KEY, revision);
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

  return (
    <InspectorGroup
      title="Absorbing Boundary"
      description="Adds object-owned Gilbert damping toward selected faces."
      collapsible
      defaultOpen={draft.enabled}
    >
      <FormField
        label="Enabled"
        type="checkbox"
        checked={draft.enabled}
        onChange={(event) => update({ enabled: event.target.checked })}
      />
      {draft.enabled ? (
        <>
          <FormField
            label="Total width"
            type="number"
            unit="m"
            value={draft.totalWidth}
            onChange={(event) => update({ totalWidth: event.target.value })}
          />
          <FormField
            label="Ramp width"
            type="number"
            unit="m"
            value={draft.rampWidth}
            onChange={(event) => update({ rampWidth: event.target.value })}
          />
          <FormField
            label="Maximum damping"
            type="number"
            value={draft.maxDamping}
            onChange={(event) => update({ maxDamping: event.target.value })}
          />
          <FormField
            label="Profile"
            type="select"
            value={draft.profile}
            onChange={(event) => update({ profile: event.target.value })}
          >
            {ABSORBING_BOUNDARY_PROFILES.map((profile) => (
              <option key={profile} value={profile}>{profile}</option>
            ))}
          </FormField>
          <FormField
            label="Frame"
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
                type="checkbox"
                checked={draft.faces.includes(face)}
                onChange={() => toggleFace(face)}
              />
            ))}
          </div>
        </>
      ) : null}
      <Button type="button" size="sm" variant="primary" disabled={mutationBusy} onClick={() => void apply()}>
        {pending ? "Saving…" : "Apply boundary"}
      </Button>
      {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    </InspectorGroup>
  );
}
