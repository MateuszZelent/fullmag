"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { ExecutionProfile } from "@/kernel/api/apiTypes";
import { useExecutionProfilesResource } from "@/kernel/resources/useExecutionProfilesResource";
import { Button } from "@/shared/ui/Button";

import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";

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
} from "./StudyExecutionProfileModel";

type ProfileResource = ReturnType<typeof useExecutionProfilesResource>;

export interface StudyExecutionProfileApplyResult {
  message?: string;
  revision?: number;
  stale?: boolean;
  success: boolean;
}

export interface StudyExecutionProfileEditSession {
  apply: () => Promise<boolean>;
  dirty: boolean;
  profileBound: boolean;
  reset: () => void;
  valid: boolean;
}

export interface StudyExecutionProfileSectionProps {
  authoringBusy: boolean;
  otherAuthoringDirty: boolean;
  scene: unknown;
  sceneRevision: number | string | null;
  sceneStatus: string;
  sessionScopeKey: string | null;
  stages: readonly unknown[];
  onApply: (
    assignment: StudyExecutionProfileAssignment,
    baseRevision: number,
  ) => Promise<StudyExecutionProfileApplyResult>;
  onEditSessionChange: (session: StudyExecutionProfileEditSession | null) => void;
}

interface CanonicalDraft {
  draft: StudyExecutionProfileDraft;
  revision: number | string | null;
}

interface EditorState {
  baseline: StudyExecutionProfileDraft;
  baselineRevision: number | string | null;
  draft: StudyExecutionProfileDraft;
  latestCanonical: CanonicalDraft;
  message: { kind: "error" | "success" | "warning"; text: string } | null;
  stale: boolean;
}

type EditorAction =
  | { type: "canonicalChanged"; canonical: CanonicalDraft }
  | { type: "setProfile"; profile: ExecutionProfile | null }
  | {
      type: "setOverride";
      key: StudyExecutionProfileOverrideKey;
      value: string;
    }
  | { type: "reset" }
  | {
      type: "applied";
      assignment: StudyExecutionProfileAssignment;
      revision: number | string | null;
    }
  | { type: "staleConflict"; message: string }
  | { type: "message"; message: EditorState["message"] };

function initialEditorState(canonical: CanonicalDraft): EditorState {
  return {
    baseline: canonical.draft,
    baselineRevision: canonical.revision,
    draft: canonical.draft,
    latestCanonical: canonical,
    message: null,
    stale: false,
  };
}

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "canonicalChanged": {
      const dirty = studyExecutionProfileDraftIsDirty(state.draft, state.baseline);
      if (!dirty) {
        return {
          baseline: action.canonical.draft,
          baselineRevision: action.canonical.revision,
          draft: action.canonical.draft,
          latestCanonical: action.canonical,
          message: null,
          stale: false,
        };
      }
      const changedRevision =
        action.canonical.revision !== null &&
        state.baselineRevision !== action.canonical.revision;
      return {
        ...state,
        latestCanonical: action.canonical,
        stale: state.stale || changedRevision,
        message: changedRevision
          ? {
              kind: "warning",
              text: "The scene revision changed while this draft was open. The draft is preserved and Apply is paused; cancel to load the latest scene before editing again.",
            }
          : state.message,
      };
    }
    case "setProfile":
      return {
        ...state,
        draft: selectStudyExecutionProfile(state.draft, action.profile),
        message: null,
      };
    case "setOverride":
      return {
        ...state,
        draft: updateStudyExecutionProfileOverride(
          state.draft,
          action.key,
          action.value,
        ),
        message: null,
      };
    case "reset":
      return {
        baseline: state.latestCanonical.draft,
        baselineRevision: state.latestCanonical.revision,
        draft: state.latestCanonical.draft,
        latestCanonical: state.latestCanonical,
        message: null,
        stale: false,
      };
    case "applied": {
      const canonical = createStudyExecutionProfileDraft({
        study: {
          execution_profile: action.assignment.execution_profile,
          execution_layers: action.assignment.execution_layers,
        },
      });
      return {
        baseline: canonical,
        baselineRevision: action.revision,
        draft: canonical,
        latestCanonical: { draft: canonical, revision: action.revision },
        message: {
          kind: "success",
          text: "Execution profile intent was saved to the scene.",
        },
        stale: false,
      };
    }
    case "staleConflict":
      return {
        ...state,
        message: { kind: "warning", text: action.message },
        stale: true,
      };
    case "message":
      return { ...state, message: action.message };
  }
}

function numericRevision(value: number | string | null): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function profileLabel(profile: ExecutionProfile): string {
  return `${profile.profile_id} · ${profile.version}`;
}

export function StudyExecutionProfileSection(
  props: StudyExecutionProfileSectionProps,
) {
  const resource = useExecutionProfilesResource();
  const editorKey = `${props.sessionScopeKey ?? "no-session"}:${resource.scope}`;
  return <StudyExecutionProfileEditor key={editorKey} resource={resource} {...props} />;
}

function StudyExecutionProfileEditor({
  authoringBusy,
  otherAuthoringDirty,
  onApply,
  onEditSessionChange,
  scene,
  sceneRevision,
  sceneStatus,
  stages,
  resource,
}: StudyExecutionProfileSectionProps & { resource: ProfileResource }) {
  const [applying, setApplying] = useState(false);
  const [state, dispatch] = useReducer(
    editorReducer,
    { scene, revision: sceneRevision },
    ({ scene: initialScene, revision }) =>
      initialEditorState({
        draft: createStudyExecutionProfileDraft(initialScene),
        revision,
      }),
  );
  const inflight = useRef(false);
  const dirty = studyExecutionProfileDraftIsDirty(state.draft, state.baseline);
  const validationError = validateStudyExecutionProfileDraft(state.draft);
  const cpuThreadsText = state.draft.overrides.cpuThreads.trim();
  const cpuThreadsValue = Number(cpuThreadsText);
  const cpuThreadsError =
    cpuThreadsText &&
    cpuThreadsText !== "auto" &&
    (!/^\d+$/.test(cpuThreadsText) ||
      !Number.isSafeInteger(cpuThreadsValue) ||
      cpuThreadsValue <= 0 ||
      cpuThreadsValue > 4_294_967_295)
      ? "Use Inherit, Auto, or an integer from 1 to 4294967295."
      : undefined;
  const hasChangeDeviceConflict =
    state.draft.profile !== null && hasChangeDeviceStudyStage(scene, stages);
  const resourceReady =
    resource.status === "ready" &&
    !resource.error &&
    !resource.refreshError &&
    Boolean(resource.data);
  const sceneReady =
    sceneStatus === "ready" &&
    scene !== null &&
    scene !== undefined &&
    numericRevision(sceneRevision) !== null;
  const profiles = resource.data?.entries.map((entry) => entry.profile) ?? [];
  const selectedProfileKey = state.draft.profile
    ? studyExecutionProfileKey(state.draft.profile)
    : "__legacy__";
  const profileNotInCatalog =
    state.draft.profile !== null &&
    !profiles.some((profile) =>
      sameStudyExecutionProfile(profile, state.draft.profile),
    );
  const studyLayerCount = state.draft.layers.filter((layer) => {
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) return false;
    const origin = (layer as { origin?: unknown }).origin;
    return Boolean(
      origin &&
        typeof origin === "object" &&
        !Array.isArray(origin) &&
        (origin as { kind?: unknown }).kind === "study",
    );
  }).length;
  const applyBlockReason = hasChangeDeviceConflict
    ? "Remove the Change device stage or clear the profile before applying."
    : validationError;

  useEffect(() => {
    if (!sceneReady) return;
    dispatch({
      type: "canonicalChanged",
      canonical: {
        draft: createStudyExecutionProfileDraft(scene),
        revision: sceneRevision,
      },
    });
  }, [scene, sceneReady, sceneRevision]);

  const resetDraft = useCallback(() => {
    dispatch({ type: "reset" });
  }, []);

  const applyDraft = useCallback(async (): Promise<boolean> => {
    if (!dirty || applying || inflight.current || applyBlockReason || !sceneReady || state.stale) return false;
    if (state.draft.profile !== null && !resourceReady) return false;
    const baseRevision = numericRevision(state.baselineRevision);
    if (baseRevision === null) {
      dispatch({
        type: "message",
        message: {
          kind: "error",
          text: "The canonical scene revision is unavailable. Refresh the scene before applying this profile.",
        },
      });
      return false;
    }

    let assignment: StudyExecutionProfileAssignment;
    try {
      assignment = buildStudyExecutionProfileAssignment(state.draft);
    } catch (error) {
      dispatch({
        type: "message",
        message: {
          kind: "error",
          text: error instanceof Error ? error.message : "The profile draft is invalid.",
        },
      });
      return false;
    }

    inflight.current = true;
    setApplying(true);
    try {
      const result = await onApply(assignment, baseRevision);
      if (!result.success) {
        if (result.stale) {
          dispatch({
            type: "staleConflict",
            message:
              result.message ??
              "The scene revision changed. The draft is preserved; cancel to load the latest scene.",
          });
          return false;
        }
        dispatch({
          type: "message",
          message: {
            kind: "error",
            text: result.message ?? "The execution profile could not be saved. The draft was preserved.",
          },
        });
        return false;
      }
      dispatch({
        type: "applied",
        assignment,
        revision: result.revision ?? baseRevision,
      });
      return true;
    } catch (error) {
      dispatch({
        type: "message",
        message: {
          kind: "error",
          text: error instanceof Error ? error.message : "The execution profile could not be saved. The draft was preserved.",
        },
      });
      return false;
    } finally {
      inflight.current = false;
      setApplying(false);
    }
  }, [
    applyBlockReason,
    applying,
    dirty,
    onApply,
    resourceReady,
    sceneReady,
    state.baselineRevision,
    state.draft,
    state.stale,
  ]);

  useEffect(() => {
    onEditSessionChange({
      apply: applyDraft,
      dirty,
      profileBound: state.draft.profile !== null,
      reset: resetDraft,
      valid:
        !dirty ||
        (!validationError &&
          !hasChangeDeviceConflict &&
          !state.stale &&
          sceneReady &&
          (state.draft.profile === null || resourceReady)),
    });
  }, [
    applyDraft,
    dirty,
    hasChangeDeviceConflict,
    onEditSessionChange,
    resetDraft,
    state.draft.profile,
    state.stale,
    resourceReady,
    sceneReady,
    validationError,
  ]);
  useEffect(
    () => () => onEditSessionChange(null),
    [onEditSessionChange],
  );

  const chooseProfile = (key: string) => {
    const profile = key === "__legacy__"
      ? null
      : profiles.find((candidate) => studyExecutionProfileKey(candidate) === key) ??
        (state.draft.profile && studyExecutionProfileKey(state.draft.profile) === key
          ? state.draft.profile
          : null);
    dispatch({ type: "setProfile", profile });
  };
  const changeProfileDisabled =
    !sceneReady || authoringBusy;
  const canApply =
    dirty &&
    !authoringBusy &&
    !applying &&
    sceneReady &&
    !applyBlockReason &&
    !state.stale &&
    (state.draft.profile === null || resourceReady);

  return (
    <InspectorGroup
      badge={state.draft.profile ? profileLabel(state.draft.profile) : "Legacy"}
      description="Study execution intent from an immutable profile and sparse Study overrides. Admission is not evaluated here."
      title="Study Execution Profile"
    >
      <div data-study-execution-profile="">
        <FieldRow
          label="Profile intent"
          value={state.draft.profile ? profileLabel(state.draft.profile) : "None · legacy execution settings"}
        />
        <FieldRow label="Admission" value="Not evaluated" />
        <FormField
          disabled={changeProfileDisabled}
          label="Immutable profile version"
          type="select"
          value={selectedProfileKey}
          onChange={(event) => chooseProfile(event.target.value)}
        >
          <option value="__legacy__">None · use legacy execution settings</option>
          {profileNotInCatalog && state.draft.profile ? (
            <option disabled={!resourceReady} value={selectedProfileKey}>
              {profileLabel(state.draft.profile)} · current scene snapshot
            </option>
          ) : null}
          {profiles.map((profile) => (
            <option
              disabled={!resourceReady}
              key={studyExecutionProfileKey(profile)}
              value={studyExecutionProfileKey(profile)}
            >
              {profileLabel(profile)}
              {profile.description ? ` · ${profile.description}` : ""}
            </option>
          ))}
        </FormField>

        <div className="grid gap-fm-inspector-control">
          <FormField
            disabled={!sceneReady || authoringBusy || state.draft.profile === null}
            label="Backend override"
            type="select"
            value={state.draft.overrides.backend}
            onChange={(event) =>
              dispatch({ type: "setOverride", key: "backend", value: event.target.value })
            }
          >
            <option value="">Inherit</option>
            {unknownOption(state.draft.overrides.backend, ["auto", "fdm", "fem", "hybrid"])}
            <option value="auto">Auto</option>
            <option value="fdm">FDM</option>
            <option value="fem">FEM</option>
            <option value="hybrid">Hybrid</option>
          </FormField>
          <FormField
            disabled={!sceneReady || authoringBusy || state.draft.profile === null}
            label="Device override"
            type="select"
            value={state.draft.overrides.device}
            onChange={(event) =>
              dispatch({ type: "setOverride", key: "device", value: event.target.value })
            }
          >
            <option value="">Inherit</option>
            {unknownOption(state.draft.overrides.device, ["auto", "cpu", "gpu"])}
            <option value="auto">Auto</option>
            <option value="cpu">CPU</option>
            <option value="gpu">GPU</option>
          </FormField>
          <FormField
            disabled={!sceneReady || authoringBusy || state.draft.profile === null}
            label="Precision override"
            type="select"
            value={state.draft.overrides.precision}
            onChange={(event) =>
              dispatch({ type: "setOverride", key: "precision", value: event.target.value })
            }
          >
            <option value="">Inherit</option>
            {unknownOption(state.draft.overrides.precision, ["single", "double"])}
            <option value="single">Single</option>
            <option value="double">Double</option>
          </FormField>
          <FormField
            disabled={!sceneReady || authoringBusy || state.draft.profile === null}
            label="Execution mode override"
            type="select"
            value={state.draft.overrides.mode}
            onChange={(event) =>
              dispatch({ type: "setOverride", key: "mode", value: event.target.value })
            }
          >
            <option value="">Inherit</option>
            {unknownOption(state.draft.overrides.mode, ["strict", "extended", "hybrid"])}
            <option value="strict">Strict</option>
            <option value="extended">Extended</option>
            <option value="hybrid">Hybrid</option>
          </FormField>
          <FormField
            disabled={!sceneReady || authoringBusy || state.draft.profile === null}
            error={cpuThreadsError}
            hint="Blank means Inherit; Auto records an explicit automatic request. Counts range from 1 to 4294967295."
            label="CPU threads override"
            type="text"
            value={state.draft.overrides.cpuThreads}
            onChange={(event) =>
              dispatch({ type: "setOverride", key: "cpuThreads", value: event.target.value })
            }
          />
        </div>

        {resource.error || resource.refreshError ? (
          <FeedbackBanner
            kind="error"
            message={(resource.error ?? resource.refreshError)?.message ?? "Profile catalogue is unavailable."}
          />
        ) : null}
        {!resource.data && resource.status === "loading" ? (
          <p role="status">Loading immutable profile versions…</p>
        ) : null}
        {resource.data && !resourceReady ? (
          <p role="status">Showing the last catalogue reading. Refresh before assigning a profile.</p>
        ) : null}
        {resource.data ? (
          <FieldRow label="Catalogue revision" value={String(resource.data.revision)} />
        ) : null}
        {studyLayerCount > 0 ? (
          <p>
            {studyLayerCount} authored Study layer{studyLayerCount === 1 ? " is" : "s are"} retained.
            {state.draft.profile === null
              ? " Clearing the profile also clears its execution layers."
              : " Other layers and advanced settings are preserved unless edited above."}
          </p>
        ) : (
          <p>Other execution layers and advanced profile values are preserved when assigning a version.</p>
        )}
        {hasChangeDeviceConflict ? (
          <FeedbackBanner
            kind="error"
            message="A Change device stage cannot be combined with an execution profile. Remove that stage or clear the profile before applying."
          />
        ) : null}
        {dirty && otherAuthoringDirty ? (
          <FeedbackBanner
            kind="warning"
            message="Apply or cancel the execution profile first, then save the other Study edits."
          />
        ) : null}
        {state.stale ? (
          <FeedbackBanner
            kind="warning"
            message="This draft uses an older scene revision. Cancel to reload the latest scene before making another profile change."
          />
        ) : null}
        {applyBlockReason && !hasChangeDeviceConflict ? (
          <FeedbackBanner kind="error" message={applyBlockReason} />
        ) : null}
        {state.message ? (
          <FeedbackBanner kind={state.message.kind} message={state.message.text} />
        ) : null}

        <div className="fm-inspector-toolbar">
          <Button
            disabled={authoringBusy || applying || resource.status === "loading"}
            onClick={() => resource.refetch()}
            size="sm"
            type="button"
            variant="secondary"
          >
            Refresh profiles
          </Button>
          <Button
            disabled={!canApply}
            onClick={() => void applyDraft()}
            size="sm"
            type="button"
          >
            Apply execution profile
          </Button>
          <Button
            disabled={!dirty || authoringBusy || applying}
            onClick={resetDraft}
            size="sm"
            type="button"
            variant="secondary"
          >
            Cancel
          </Button>
        </div>
      </div>
    </InspectorGroup>
  );
}

function unknownOption(value: string, known: readonly string[]) {
  return value && !known.includes(value)
    ? <option value={value}>Existing value · {value}</option>
    : null;
}
