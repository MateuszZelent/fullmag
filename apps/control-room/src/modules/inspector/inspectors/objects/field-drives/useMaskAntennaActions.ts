"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  MODEL_MASK_FIELD_DRIVES_PATH,
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_READY_ANTENNAS_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  MaskFieldDriveResource,
  ReadyAntennaListResource,
  ReadyAntennaResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import {
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { publishCommittedSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import * as maskAntennaResources from "@/kernel/resources/maskAntennaResources";
import { useResource } from "@/kernel/resources/useResource";
import { useSessionScopedResourceKey } from "@/kernel/resources/useSessionScopedResourceKey";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  commitMaskAntenna,
  mergeMaskAntennaDraft,
  replaceReadyAntennaCall,
  sameJson,
} from "../../../panels/MaskAntennaPanelModel";
import { buildRootSelection, fallbackRevision } from "../../../panels/model-roots/SpecInspectorHost";

import {
  applyRawInputs,
  buildMaskAntennaSelection,
  NEW_READY_CALL,
  READY_TERMS_PENDING_REASON,
  readyCallTerms,
  SCENE_CHANGED_REASON,
  UNSELECTED_READY_ANTENNA,
  type AcknowledgedMaskAntenna,
  type RawInputs,
  type ReadyTerms,
} from "./fieldDriveMaskShared";

const useFallbackReadyAntennasResource = ({ enabled = true }: { enabled?: boolean } = {}) => {
  const kernel = useKernel();
  const hasResourceSystem = typeof kernel.resources?.subscribe === "function";
  const canLoad = hasResourceSystem && typeof kernel.api?.model?.readyAntennas === "function";
  const { resourceKey, sessionIdentity } = useSessionScopedResourceKey(
    MODEL_READY_ANTENNAS_PATH,
  );
  const load = useCallback(
    ({ sessionScopeKey, signal }: { sessionScopeKey?: string; signal: AbortSignal }) =>
      kernel.api.model.readyAntennas({ sessionScopeKey, signal }),
    [kernel.api.model],
  );
  const res = useResource<ReadyAntennaListResource>({
    enabled: enabled && canLoad && sessionIdentity !== null,
    load,
    resourceKey,
  });
  if (!canLoad) {
    return { data: { antennas: [] as ReadyAntennaResource[] }, status: "ready" as const, error: null };
  }
  return res;
};

export function useSafeReadyAntennasResource(options?: { enabled?: boolean }) {
  const exportedHook =
    "useReadyAntennasResource" in maskAntennaResources &&
    typeof maskAntennaResources.useReadyAntennasResource === "function"
      ? maskAntennaResources.useReadyAntennasResource
      : useFallbackReadyAntennasResource;
  return exportedHook(options);
}

export interface UseMaskAntennaActionsParams {
  clearDraftState: () => void;
  conflict: boolean;
  dirty: boolean;
  draft: MaskFieldDriveResource | null;
  draftBase: MaskFieldDriveResource | null;
  drive: MaskFieldDriveResource | null;
  effectiveSceneDrive: MaskFieldDriveResource | null;
  identityKey: string;
  modelMode: string;
  modelSceneRevision: number | null;
  own: MaskFieldDriveResource | null;
  ownRaw: RawInputs;
  sceneData: SceneResource | null;
  selection: Selection;
  sessionScopeKey: string | null;
  setAcknowledged: (ack: AcknowledgedMaskAntenna | null) => void;
  setAppliedFlash: (flash: boolean) => void;
  setDraft: (update: (value: MaskFieldDriveResource) => MaskFieldDriveResource) => void;
  setFeedback: (feedback: { kind: "error" | "success"; message: string } | null) => void;
  setNewReadyFunction: (fn: string) => void;
  setServerConflictDrive: (
    conflictDrive: { key: string; drive: MaskFieldDriveResource } | null,
  ) => void;
  termsLocked: boolean;
  validationErrors: readonly string[];
}

export function useMaskAntennaActions({
  clearDraftState,
  conflict,
  dirty,
  draft,
  draftBase,
  drive,
  effectiveSceneDrive,
  identityKey,
  modelMode,
  modelSceneRevision,
  own,
  ownRaw,
  sceneData,
  selection,
  sessionScopeKey,
  setAcknowledged,
  setAppliedFlash,
  setDraft,
  setFeedback,
  setNewReadyFunction,
  setServerConflictDrive,
  termsLocked,
  validationErrors,
}: UseMaskAntennaActionsParams) {
  const kernel = useKernel();
  const { api, resources } = kernel;

  const identityKeyRef = useRef(identityKey);
  useLayoutEffect(() => {
    identityKeyRef.current = identityKey;
  }, [identityKey]);

  const [pendingId, setPendingId] = useState<number | null>(null);
  const nextOperationId = useRef(0);
  const [readyRequest, setReadyRequest] = useState<{ key: string; selection: Selection } | null>(
    null,
  );
  const activeReadyRequest = useRef<typeof readyRequest>(null);
  const readyBusy = readyRequest?.selection === selection ? readyRequest.key : null;
  const pending = pendingId !== null;
  const effectiveTermsLocked = termsLocked || pending;

  const cancelReadyRequest = useCallback(() => {
    activeReadyRequest.current = null;
    setReadyRequest(null);
  }, []);
  useLayoutEffect(
    () => () => {
      activeReadyRequest.current = null;
    },
    [selection],
  );

  const applyReadyTerms = useRef<
    ((callIndex: number | null, terms: ReadyTerms, previous: ReadyTerms | null) => boolean) | null
  >(null);
  useLayoutEffect(() => {
    applyReadyTerms.current = (callIndex, terms, previous) => {
      if (!draft || effectiveTermsLocked) return false;
      if (callIndex !== null && !sameJson(readyCallTerms(draft, callIndex), previous)) {
        return false;
      }
      setDraft((value) => replaceReadyAntennaCall(value, callIndex, terms));
      return true;
    };
    return () => {
      applyReadyTerms.current = null;
    };
  });

  const synchronousCleanRef = useRef(false);
  useLayoutEffect(() => {
    synchronousCleanRef.current = false;
  }, [dirty, identityKey, selection]);

  function mutationContext() {
    return captureAuthoringMutationFence(
      createCommandContext("inspector", kernel, {
        resourceData: sceneData ? { [MODEL_SCENE_PATH]: sceneData } : undefined,
        selection: typeof kernel.selection?.get === "function" ? kernel.selection : undefined,
        sourceDetail: "FieldDriveMaskSpec",
      }),
    );
  }

  async function runMutation(
    label: string,
    mutate: (
      baseRevision: number,
      scopeKey: string,
    ) => Promise<{ committed_scene?: MaskFieldDriveResource | unknown; scene_revision: number }>,
    onDone: (sceneRevision: number) => void,
  ): Promise<boolean> {
    const context = mutationContext();
    const scopeKey = context.sessionScopeKey;
    if (!scopeKey || context.isCurrentSessionScope?.() !== true) {
      setFeedback({
        kind: "error",
        message: "An active session is required to change this antenna.",
      });
      return false;
    }
    const operationId = ++nextOperationId.current;
    const isCurrent = () =>
      identityKeyRef.current === identityKey && nextOperationId.current === operationId;
    setPendingId(operationId);
    setFeedback(null);
    try {
      const response = await runAuthoringMutationWithHistory(
        context,
        label,
        ({ baseRevision }) => {
          const revision = baseRevision ?? modelSceneRevision;
          if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
            throw new Error(
              "The scene revision is unavailable. Refetch before changing the antenna.",
            );
          }
          return mutate(revision, scopeKey);
        },
      );
      if (context.isCurrentSessionScope?.() !== true) return false;
      const rev = response.scene_revision;
      if (response.committed_scene && typeof response.committed_scene === "object") {
        publishCommittedSceneResource(
          resources,
          response.committed_scene as Parameters<typeof publishCommittedSceneResource>[1],
          rev,
        );
      }
      resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, rev);
      resources.invalidate(MODEL_SCENE_PATH, rev);
      resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, fallbackRevision(rev));
      invalidateAuthoringMutationDependents(resources, "interaction", rev);
      if (!isCurrent()) return false;
      onDone(rev);
      return true;
    } catch (error) {
      if (context.isCurrentSessionScope?.() !== true || !isCurrent()) return false;
      const errStatus = (error as { status?: number } | null)?.status;
      const errMessage = error instanceof Error ? error.message : String(error);
      if (
        (errStatus === 409 || /conflict|revision/i.test(errMessage)) &&
        typeof api.model.maskFieldDrives === "function" &&
        modelMode === "found" &&
        drive
      ) {
        try {
          const latest = await api.model.maskFieldDrives({ sessionScopeKey: scopeKey });
          resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, latest.scene_revision);
          const serverItem = latest.drives.find((item) => item.id === drive.id);
          if (serverItem && isCurrent()) {
            setServerConflictDrive({ key: identityKey, drive: serverItem });
          }
        } catch {
          // Keep original error message below if refetch fails.
        }
      }
      setFeedback({ kind: "error", message: errMessage });
      return false;
    } finally {
      setPendingId((current) => (current === operationId ? null : current));
    }
  }

  const saveRef = useRef<() => Promise<boolean>>(async () => false);

  async function save(): Promise<boolean> {
    if (!draft || (modelMode !== "create" && modelMode !== "found")) return false;
    if (conflict) {
      setFeedback({ kind: "error", message: SCENE_CHANGED_REASON });
      return false;
    }
    if (activeReadyRequest.current?.selection === selection) {
      setFeedback({ kind: "error", message: READY_TERMS_PENDING_REASON });
      return false;
    }
    if (validationErrors.length > 0) {
      setFeedback({ kind: "error", message: validationErrors.join(" ") });
      return false;
    }
    const mode = modelMode;
    const edits =
      mode === "found" && own && draftBase
        ? { base: draftBase, mine: applyRawInputs(own, ownRaw) }
        : null;
    const listed = effectiveSceneDrive;
    let submitted = draft;

    return runMutation(
      `${mode === "create" ? "Create" : "Update"} mask antenna ${submitted.id}`,
      async (baseRevision, scopeKey) => {
        if (edits && listed && typeof api.model.maskFieldDrives === "function") {
          const current = await api.model.maskFieldDrives({ sessionScopeKey: scopeKey });
          if (current.scene_revision !== baseRevision) {
            resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, current.scene_revision);
            throw new Error("The scene changed while saving. Apply again.");
          }
          const server = current.drives.find((item) => item.id === submitted.id);
          if (!server) {
            throw new Error(`Mask antenna ${submitted.id} is no longer in the scene.`);
          }
          if (!sameJson(server, listed)) {
            resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, current.scene_revision);
            const merged = mergeMaskAntennaDraft(edits.base, edits.mine, server);
            if (merged.conflicts.length > 0) {
              setServerConflictDrive({ key: identityKey, drive: server });
              throw new Error(
                "Not saved: this antenna changed in the scene in fields you also edited.",
              );
            }
            submitted = merged.merged;
          }
        }
        return commitMaskAntenna(api.model, mode, baseRevision, submitted, {
          sessionScopeKey: scopeKey,
        });
      },
      (sceneRevision) => {
        synchronousCleanRef.current = true;
        cancelReadyRequest();
        clearDraftState();
        if (mode === "found") {
          setAcknowledged({ drive: submitted, key: identityKey, revision: sceneRevision });
        }
        setAppliedFlash(true);
        setFeedback({
          kind: "success",
          message: mode === "create" ? "Mask antenna created." : "Mask antenna saved.",
        });
        if (mode === "create") {
          kernel.selection.set(buildMaskAntennaSelection(submitted), "inspector");
        }
      },
    );
  }
  useLayoutEffect(() => {
    saveRef.current = save;
  });

  async function removeAntenna(): Promise<void> {
    if (!drive || modelMode !== "found") return;
    await runMutation(
      `Delete mask antenna ${drive.id}`,
      (baseRevision, scopeKey) =>
        api.model.deleteMaskFieldDrive(
          drive.id,
          { base_revision: baseRevision },
          { sessionScopeKey: scopeKey },
        ),
      () => {
        synchronousCleanRef.current = true;
        cancelReadyRequest();
        clearDraftState();
        kernel.selection.set(
          buildRootSelection("physics.field-drives", "model:physics:field-drives", "Field Drives"),
          "inspector",
        );
      },
    );
  }

  const buildReadyTermsImplRef = useRef<
    (
      antenna: ReadyAntennaResource,
      callIndex: number | null,
      values: Record<string, number>,
    ) => Promise<void>
  >(async () => {});

  useLayoutEffect(() => {
    buildReadyTermsImplRef.current = async (antenna, callIndex, values) => {
      if (!draft || effectiveTermsLocked || activeReadyRequest.current?.selection === selection) return;
      const previous = callIndex === null ? null : readyCallTerms(draft, callIndex);
      const request = {
        key: callIndex === null ? NEW_READY_CALL : String(callIndex),
        selection,
      };
      activeReadyRequest.current = request;
      setReadyRequest(request);
      const isCurrent = () =>
        activeReadyRequest.current === request && identityKeyRef.current === identityKey;
      setFeedback(null);
      try {
        const response = await api.model.readyAntennaTerms(
          { arguments: values, function: antenna.function },
          sessionScopeKey ? { sessionScopeKey } : undefined,
        );
        if (!isCurrent()) return;
        if (!applyReadyTerms.current?.(callIndex, response.terms, previous)) {
          setFeedback({
            kind: "error",
            message: "The antenna terms changed while building. Build them again.",
          });
          return;
        }
        if (callIndex === null) setNewReadyFunction(UNSELECTED_READY_ANTENNA);
      } catch (error) {
        if (!isCurrent()) return;
        setFeedback({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (activeReadyRequest.current === request) activeReadyRequest.current = null;
        setReadyRequest((current) => (current === request ? null : current));
      }
    };
  });

  const buildReadyAntennaTerms = useCallback(
    (
      antenna: ReadyAntennaResource,
      callIndex: number | null,
      values: Record<string, number>,
    ): Promise<void> => buildReadyTermsImplRef.current(antenna, callIndex, values),
    [],
  );

  const removeAntennaRef = useRef<() => Promise<void>>(async () => {});
  useLayoutEffect(() => {
    removeAntennaRef.current = removeAntenna;
  });

  const onRemoveAntenna = useCallback(() => removeAntennaRef.current(), []);
  const onApplySave = useCallback(() => saveRef.current(), []);
  const isSynchronouslyClean = useCallback(() => synchronousCleanRef.current, []);

  return {
    buildReadyAntennaTerms,
    cancelReadyRequest,
    isSynchronouslyClean,
    onApplySave,
    onRemoveAntenna,
    pending,
    readyBusy,
  };
}
