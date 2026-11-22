"use client";

import { useCallback, useMemo, useState } from "react";

import type { SceneResource } from "@/kernel/api/apiTypes";
import {
  useExecutionProfilesResource,
} from "@/kernel/resources/useExecutionProfilesResource";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import {
  buildStudyExecutionProfileAssignment,
  createStudyExecutionProfileDraft,
  hasChangeDeviceStudyStage,
  sameStudyExecutionProfile,
  selectStudyExecutionProfile,
  studyExecutionProfileDraftIsDirty,
  studyExecutionProfileKey,
  updateStudyExecutionProfileOverride,
  validateStudyExecutionProfileDraft,
  type StudyExecutionProfileAssignment,
  type StudyExecutionProfileDraft,
  type StudyExecutionProfileOverrideKey,
} from "../../panels/StudyExecutionProfileModel";
import {
  resolveFdmGridPreview,
  type StudyGlobalDraft,
} from "../../panels/StudyGlobalAuthoringModel";
import { formatGridVector } from "../../panels/studyInspectorShared";
import type { StudyExecutionDraft } from "./studyShared";
export function StudyExecutionProfileRadixCard({
  onApplyAssignment,
  sceneData,
  sessionDiscretization,
  stages,
}: {
  onApplyAssignment: (assignment: StudyExecutionProfileAssignment) => Promise<boolean>;
  sceneData: SceneResource | null;
  sessionDiscretization: string | null;
  stages: readonly unknown[];
}) {
  const resource = useExecutionProfilesResource();
  const canonicalDraft = useMemo(
    () => createStudyExecutionProfileDraft(sceneData),
    [sceneData],
  );
  const canonicalKey = useMemo(() => JSON.stringify(canonicalDraft), [canonicalDraft]);
  const [draftState, setDraftState] = useState<{
    baseKey: string;
    value: StudyExecutionProfileDraft;
  }>(() => ({ baseKey: canonicalKey, value: canonicalDraft }));
  const draft =
    draftState.baseKey === canonicalKey ? draftState.value : canonicalDraft;
  const setDraft = useCallback(
    (
      updater:
        | StudyExecutionProfileDraft
        | ((prev: StudyExecutionProfileDraft) => StudyExecutionProfileDraft),
    ) => {
      setDraftState((prev) => {
        const current =
          prev.baseKey === canonicalKey ? prev.value : canonicalDraft;
        const next = typeof updater === "function" ? updater(current) : updater;
        return { baseKey: canonicalKey, value: next };
      });
    },
    [canonicalDraft, canonicalKey],
  );
  const [applying, setApplying] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const dirty = studyExecutionProfileDraftIsDirty(draft, canonicalDraft);
  const validationError = validateStudyExecutionProfileDraft(draft);
  const hasChangeDeviceConflict =
    draft.profile !== null && hasChangeDeviceStudyStage(sceneData, stages);
  const profiles = resource.data?.entries.map((entry) => entry.profile) ?? [];
  const selectedKey = draft.profile
    ? studyExecutionProfileKey(draft.profile)
    : "__legacy__";
  const profileNotInCatalog =
    draft.profile !== null &&
    !profiles.some((p) => sameStudyExecutionProfile(p, draft.profile));

  const setOverride = (key: StudyExecutionProfileOverrideKey, value: string) => {
    setDraft((prev) => updateStudyExecutionProfileOverride(prev, key, value));
    setFeedback(null);
  };

  return (
    <div className="grid gap-2 rounded-md border border-fm-border-subtle p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-fm-primary">
          Immutable Execution Profile
        </span>
        <Badge>
          {draft.profile
            ? `${draft.profile.profile_id} · ${draft.profile.version}`
            : "Legacy"}
        </Badge>
      </div>

      <div className="fm-inspector-row" data-layout="inline">
        <span className="fm-inspector-row__label">Profile version</span>
        <div className="fm-inspector-row__control">
          <Select
            value={selectedKey}
            onValueChange={(key) => {
              const found =
                key === "__legacy__"
                  ? null
                  : profiles.find((p) => studyExecutionProfileKey(p) === key) ??
                    (draft.profile && studyExecutionProfileKey(draft.profile) === key
                      ? draft.profile
                      : null);
              setDraft((prev) => selectStudyExecutionProfile(prev, found));
              setFeedback(null);
            }}
          >
            <SelectTrigger aria-label="Immutable profile version" density="compact">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__legacy__">
                None · use direct study settings
              </SelectItem>
              {profileNotInCatalog && draft.profile ? (
                <SelectItem value={selectedKey}>
                  {draft.profile.profile_id} · {draft.profile.version} (current)
                </SelectItem>
              ) : null}
              {profiles.map((p) => (
                <SelectItem
                  key={studyExecutionProfileKey(p)}
                  value={studyExecutionProfileKey(p)}
                >
                  {p.profile_id} · {p.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {draft.profile !== null ? (
        <div className="grid gap-1.5 border-t border-fm-border-subtle pt-2">
          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Discretization</span>
            <div className="fm-inspector-row__control">
              <span className="text-xs text-fm-secondary">
                {sessionDiscretization === "fem"
                  ? "FEM (Session)"
                  : sessionDiscretization === "fdm"
                    ? "FDM (Session)"
                    : "Inherited from session"}
              </span>
            </div>
          </div>

          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Device override</span>
            <div className="fm-inspector-row__control">
              <Select
                value={draft.overrides.device || "__inherit__"}
                onValueChange={(v) =>
                  setOverride("device", v === "__inherit__" ? "" : v)
                }
              >
                <SelectTrigger aria-label="Device override" density="compact">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit</SelectItem>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="cpu">CPU</SelectItem>
                  <SelectItem value="gpu">GPU</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Precision override</span>
            <div className="fm-inspector-row__control">
              <Select
                value={draft.overrides.precision || "__inherit__"}
                onValueChange={(v) =>
                  setOverride("precision", v === "__inherit__" ? "" : v)
                }
              >
                <SelectTrigger aria-label="Precision override" density="compact">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit</SelectItem>
                  <SelectItem value="double">Double (FP64)</SelectItem>
                  <SelectItem value="single">Single (FP32)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">Mode override</span>
            <div className="fm-inspector-row__control">
              <Select
                value={draft.overrides.mode || "__inherit__"}
                onValueChange={(v) =>
                  setOverride("mode", v === "__inherit__" ? "" : v)
                }
              >
                <SelectTrigger aria-label="Execution mode override" density="compact">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit</SelectItem>
                  <SelectItem value="strict">Strict</SelectItem>
                  <SelectItem value="extended">Extended</SelectItem>
                  <SelectItem value="hybrid">Hybrid</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="fm-inspector-row" data-layout="inline">
            <span className="fm-inspector-row__label">CPU threads override</span>
            <div className="fm-inspector-row__control">
              <Input
                aria-label="CPU threads override"
                className="h-fm-control-sm font-mono"
                placeholder="Inherit or integer"
                value={draft.overrides.cpuThreads}
                onChange={(e) => setOverride("cpuThreads", e.target.value)}
              />
            </div>
          </div>
        </div>
      ) : null}

      {hasChangeDeviceConflict ? (
        <div className="text-fm-danger" role="alert">
          Remove the Change Device stage or clear the execution profile before applying.
        </div>
      ) : validationError ? (
        <div className="text-fm-danger" role="alert">
          {validationError}
        </div>
      ) : feedback ? (
        <div className="text-fm-muted" role="status">
          {feedback}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        <Button
          disabled={applying || resource.status === "loading"}
          size="sm"
          type="button"
          variant="secondary"
          onClick={() => resource.refetch()}
        >
          Refresh profiles
        </Button>
        <Button
          disabled={
            !dirty ||
            applying ||
            Boolean(validationError) ||
            hasChangeDeviceConflict
          }
          size="sm"
          type="button"
          variant="primary"
          onClick={async () => {
            try {
              setApplying(true);
              const assignment = buildStudyExecutionProfileAssignment(draft);
              const ok = await onApplyAssignment(assignment);
              setFeedback(
                ok ? "Execution profile saved." : "Could not save execution profile.",
              );
            } catch (err) {
              setFeedback(err instanceof Error ? err.message : "Invalid profile.");
            } finally {
              setApplying(false);
            }
          }}
        >
          Save profile binding
        </Button>
        <Button
          disabled={!dirty || applying}
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => {
            setDraft(canonicalDraft);
            setFeedback(null);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function StudyExecutionFdmGridPreview({
  draft,
  globalDraftForPreview,
  onApplyFdmGrid,
  sceneData,
}: {
  draft: StudyExecutionDraft;
  globalDraftForPreview?: StudyGlobalDraft;
  onApplyFdmGrid?: () => Promise<void>;
  sceneData: SceneResource | null;
}) {
                if (!sceneData || !globalDraftForPreview) return null;
                const preview = resolveFdmGridPreview(sceneData, {
                  ...globalDraftForPreview,
                  requestedBackend: "fdm",
                  fdm: {
                    boundaryCorrection: draft.fdmBoundaryCorrection,
                    boundaryDeltaMin: String(draft.boundaryDeltaMinM),
                    boundaryPhiFloor: String(draft.boundaryPhiFloor),
                    commonCells: draft.fdmCommonCells,
                    commonCellsXy: draft.fdmCommonCellsXy,
                    defaultCell: draft.fdmDefaultCell,
                    demagExplain: draft.fdmDemagExplain,
                    demagMode: draft.fdmDemagMode,
                    demagStrategy: draft.fdmDemagStrategy,
                    perMagnet: draft.fdmPerMagnet,
                  },
                });
                if (!preview || preview.entries.length === 0) {
                  return (
                    <div className="text-xs text-fm-muted">
                      Enter a valid FDM default cell to preview mesh cell counts.
                    </div>
                  );
                }
                return (
                  <div className="grid gap-1 rounded border border-fm-border-subtle p-2 text-xs tabular-nums">
                    {preview.entries.map((entry) => (
                      <div
                        className="flex items-center justify-between gap-2"
                        key={entry.objectId}
                      >
                        <span className="font-mono">{entry.objectId}</span>
                        <span>
                          {entry.counts.join(" × ")} ({formatGridVector(entry.extent)} m)
                        </span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-2 border-t border-fm-border-subtle pt-1 font-medium">
                      <span>Total cells</span>
                      <span>{preview.totalCellCount.toLocaleString("en-US")}</span>
                    </div>
                    {onApplyFdmGrid ? (
                      <div className="pt-1">
                        <Button
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => void onApplyFdmGrid()}
                        >
                          Apply FDM Grid
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
}
