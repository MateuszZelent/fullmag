import { useLayoutEffect, useRef, useState } from "react";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { SceneResource } from "@/kernel/api/apiTypes";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { commitObjectTranslation } from "@/kernel/authoring/objectTranslationMutation";
import { useKernel } from "@/kernel/KernelContext";
import { useGeometryRealizationResource } from "@/kernel/resources/useGeometryRealizationResource";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";

import { useRegisterInspectorEditSession } from "../../InspectorEditSession";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { FieldRow } from "../../primitives/FieldRow";
import { FormField } from "../../primitives/FormField";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { antennaPlacementTargets, resolveAntennaPlacement } from "./AntennaPlacementModel";

interface Draft {
  key: string;
  baseRevision: number;
  dirty: boolean;
  targetId: string;
  side: "above" | "below";
  gap: string;
}

interface Props {
  objectId: string;
  scene: SceneResource | null;
  status: string;
  refetch: () => void;
}

export function AntennaPlacementEditor({ objectId, scene, status, refetch }: Props) {
  const { api, resources, commands, authoringHistory, selection } = useKernel();
  const identity = useSessionResourceIdentity();
  const scope = sessionRequestScopeKey(identity);
  const key = `${scope ?? "unconfirmed"}|${objectId}`;
  const [ownerState, setOwnerState] = useState({ key, token: {} });
  const context = ownerState.key === key ? ownerState : { key, token: {} };
  if (ownerState.key !== key) setOwnerState(context);
  const realization = useGeometryRealizationResource(Boolean(scope));
  const [draftState, setDraft] = useState<Draft | null>(null);
  if (draftState && draftState.key !== key) setDraft(null);
  const [pendingState, setPendingState] = useState<{ token: object } | null>(null);
  const [feedback, setFeedback] = useState<{ key: string; kind: "error" | "success"; message: string } | null>(null);
  const owner = useRef<object | null>(null);
  const inflight = useRef<object | null>(null);
  useLayoutEffect(() => {
    owner.current = context.token;
    return () => { owner.current = null; };
  }, [context.token]);
  const draft = draftState?.key === key ? draftState : null;
  const targetId = draft?.targetId ?? "";
  const side = draft?.side ?? "above";
  const gap = draft?.gap ?? "5e-8";
  const dirty = draft?.dirty === true;
  const pending = pendingState?.token === context.token;
  const conflict = Boolean(dirty && !pending && scene?.revision !== draft?.baseRevision);
  const revision = typeof scene?.revision === "number" && Number.isSafeInteger(scene.revision) && scene.revision >= 0 ? scene.revision : null;
  const targets = antennaPlacementTargets(scene, objectId);
  let placement: ReturnType<typeof resolveAntennaPlacement> | null = null;
  let reason: string | null = null;
  try {
    if (!scene || !scope || scene.scene?.id !== identity?.sessionId || status !== "ready" || realization.status !== "ready" || !realization.data) {
      throw new Error("Current scene and session-scoped authoring bounds are required.");
    }
    if (!targetId) throw new Error("Select the magnetic target explicitly.");
    placement = resolveAntennaPlacement(scene, realization.data, objectId, targetId, side, Number(gap));
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  const canApply = Boolean(dirty && placement && !conflict && !pending);

  function update(patch: Partial<Pick<Draft, "targetId" | "side" | "gap">>) {
    if (revision === null) return;
    setDraft({ key, baseRevision: dirty && draft ? draft.baseRevision : revision, dirty: true, targetId, side, gap, ...patch });
    setFeedback(null);
  }

  async function apply(): Promise<boolean> {
    if (!canApply || !draft || !placement || !scene || !scope || inflight.current) return false;
    const operation = {};
    const ownerToken = context.token;
    const historyGeneration = authoringHistory?.getGeneration?.();
    const isCurrent = () => owner.current === ownerToken && ownerToken !== null &&
      commands.getSessionScopeKey() === scope &&
      (historyGeneration === undefined || authoringHistory?.getGeneration?.() === historyGeneration);
    inflight.current = operation;
    setPendingState({ token: ownerToken });
    setFeedback(null);
    try {
      const result = await runAuthoringMutationWithHistory({
        api, authoringHistory, selection, resourceData: { [MODEL_SCENE_PATH]: scene },
        sessionScopeKey: scope, isCurrentSessionScope: isCurrent,
      }, `Place antenna ${objectId} ${side} ${targetId}`, () => commitObjectTranslation({
        api, resources, objectId, baseRevision: draft.baseRevision,
        sessionScopeKey: scope, isCurrentSessionScope: isCurrent,
        translation: [...placement.translation],
      }), (response) => response.committedScene ?? null);
      if (!isCurrent()) return false;
      if (!result.committedScene || result.committedScene.scene?.id !== scene.scene?.id || !result.committedScene.objects?.some((object) => object.id === objectId)) {
        refetch();
        throw new Error("Placement ACK omitted the current antenna scene. Refresh before applying again.");
      }
      setDraft((current) => current === draft ? { ...current, baseRevision: result.revision, dirty: false } : current?.key === key && current.baseRevision === draft.baseRevision
        ? { ...current, baseRevision: result.revision } : current);
      setFeedback({ key, kind: "success", message: "Whole antenna translation committed. Rebuild meshes and recompute the field basis; old results are not current." });
      return true;
    } catch (error) {
      if (!isCurrent()) return false;
      if ((error as { status?: number })?.status === 409) { refetch(); realization.refetch(); }
      setFeedback({ key, kind: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      if (inflight.current === operation) inflight.current = null;
      setPendingState((current) => current?.token === ownerToken ? null : current);
    }
  }

  useRegisterInspectorEditSession("staged", pending, dirty, Boolean(placement && !conflict), undefined,
    apply, () => setDraft(null), { historyMode: "mutation-owned", applyBlockReason: conflict ? "Rebase placement against the current scene." : reason ?? undefined });

  return <InspectorGroup title="Antenna placement" collapsible defaultOpen>
    <FormField type="select" label="Placement target" value={targetId} onChange={(event) => update({ targetId: event.currentTarget.value })}>
      <option value="">Select magnetic object</option>
      {targets.map((target) => <option key={target.id} value={target.id}>{target.name} · {target.id}</option>)}
    </FormField>
    <FormField type="select" label="Placement side" value={side} onChange={(event) => update({ side: event.currentTarget.value === "below" ? "below" : "above" })}>
      <option value="above">Above (+world Z)</option><option value="below">Below (−world Z)</option>
    </FormField>
    <FormField label="Antenna clearance" unit="m" value={gap} onChange={(event) => update({ gap: event.currentTarget.value })}
      hint="Positive vertical gap between world-Z bounds of the entire conductor assembly and target. Not an internal conductor offset or minimum Euclidean distance." />
    <FieldRow label="Proposed Δz" unit="m" value={placement ? placement.delta[2].toExponential(6) : "unavailable"} />
    <FieldRow label="Committed translation" unit="m" value={JSON.stringify(scene?.objects?.find((object) => object.id === objectId)?.transform?.translation ?? [0, 0, 0])} />
    {reason ? <FeedbackBanner kind="warning" message={reason} /> : null}
    {conflict ? <FeedbackBanner kind="error" message="Scene changed. Refresh and explicitly rebase placement before applying." /> : null}
    {feedback?.key === key ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    <div className="fm-microstrip-station-actions">
      <Button type="button" onClick={() => { refetch(); realization.refetch(); }}>Refresh placement bounds</Button>
      {dirty ? <Button type="button" disabled={pending} onClick={() => setDraft(null)}>Revert placement</Button> : null}
      {conflict && revision !== null ? <Button type="button" disabled={pending || status !== "ready"} onClick={() => setDraft((current) => current?.key === key ? { ...current, baseRevision: revision } : current)}>Rebase placement</Button> : null}
      <Button type="button" disabled={!canApply} onClick={() => void apply()}>Apply antenna placement</Button>
    </div>
  </InspectorGroup>;
}
