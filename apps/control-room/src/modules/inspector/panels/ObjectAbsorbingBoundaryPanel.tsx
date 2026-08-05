"use client";

import { useMemo, useState } from "react";

import { SCENE_RESOURCE_KEY, useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import { useKernel } from "@/kernel/KernelContext";
import { Button } from "@/shared/ui/Button";

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

interface ObjectAbsorbingBoundaryPanelProps {
  objectId: string;
  baseRevision: number | null;
}

type Feedback = { kind: "error" | "success"; message: string } | null;

export function ObjectAbsorbingBoundaryPanel({
  objectId,
  baseRevision,
}: ObjectAbsorbingBoundaryPanelProps) {
  const { api, resources } = useKernel();
  const scene = useSceneResource();
  const object = useMemo(
    () => scene.data?.objects?.find((candidate) => candidate.id === objectId) ?? null,
    [objectId, scene.data?.objects],
  );
  const baseDraft = useMemo(
    () => absorbingBoundaryDraftFromObject(object),
    [object],
  );
  const baseKey = absorbingBoundaryDraftKey(baseDraft);
  const [draftState, setDraftState] = useState<{ key: string; draft: AbsorbingBoundaryDraft }>({
    key: baseKey,
    draft: baseDraft,
  });
  const draft = draftState.key === baseKey ? draftState.draft : baseDraft;
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const update = (patch: Partial<AbsorbingBoundaryDraft>) =>
    setDraftState({ key: baseKey, draft: { ...draft, ...patch } });
  const toggleFace = (face: string) =>
    update({
      faces: draft.faces.includes(face)
        ? draft.faces.filter((current) => current !== face)
        : [...draft.faces, face],
    });

  async function apply(): Promise<void> {
    const result = buildAbsorbingBoundaryPatch(draft, baseRevision);
    if ("error" in result) {
      setFeedback({ kind: "error", message: result.error });
      return;
    }
    setPending(true);
    try {
      const response = await api.model.patchObject(objectId, result.patch);
      const revision = typeof response.revision === "number" ? response.revision : (baseRevision ?? 0) + 1;
      resources.invalidate(SCENE_RESOURCE_KEY, revision);
      setFeedback({ kind: "success", message: "Absorbing boundary updated." });
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
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
      <Button type="button" size="sm" variant="primary" disabled={pending} onClick={() => void apply()}>
        {pending ? "Saving…" : "Apply boundary"}
      </Button>
      {feedback ? <FeedbackBanner kind={feedback.kind} message={feedback.message} /> : null}
    </InspectorGroup>
  );
}
