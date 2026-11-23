"use client";

import { Radio } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import type { MaskFieldDriveResource } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource } from "@/kernel/resources/fieldDriveResources";
import { useSceneResource } from "@/kernel/resources/geometryLifecycleResources";
import * as maskAntennaResources from "@/kernel/resources/maskAntennaResources";
import type { Selection } from "@/kernel/selection/selectionTypes";

import {
  formatInspectorSessionKey,
  useInspectorEditSessionStore,
  useRegisterInspectorEditSessionV2,
  type InspectorEditSessionV2,
} from "../../../InspectorEditSession";
import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  createMaskAntennaDraft,
  mergeMaskAntennaDraft,
  readyAntennaCalls,
  resolveMaskAntennaPanelModel,
  sameJson,
  validateMaskAntennaDraft,
} from "../../../panels/MaskAntennaPanelModel";
import { buildRootSelection } from "../../../panels/model-roots/SpecInspectorHost";
import { regionalFieldDriveSelectorOptions } from "../../../panels/RegionalFieldDrivePanelModel";
import { InspectorTemplate, type InspectorSpec } from "../../../template";

import {
  buildMaskAntennaFacts,
  buildMaskAntennaNotices,
  buildMaskAntennaSections,
} from "./FieldDriveMaskSections";
import {
  applyMaskTemplateFieldChange,
  applyRawInputs,
  computeMaskDirtyFields,
  computeMaskInvalidFields,
  consistentRawInputs,
  normalizeMaskListResource,
  rawError,
  READY_TERMS_PENDING_REASON,
  SCENE_CHANGED_REASON,
  toMaskTemplateDraft,
  UNSELECTED_READY_ANTENNA,
  validateMaskLocalsAndStageActivation,
  type AcknowledgedMaskAntenna,
  type MaskAntennaDraftState,
  type MaskAntennaTemplateDraft,
  type RawInputs,
} from "./fieldDriveMaskShared";
import { MaskCodePreviewDialog } from "./FieldDriveMaskWidgets";
import {
  extractDriveIds,
  UNSELECTED_OBJECT,
  UNSELECTED_REGION,
} from "./fieldDriveShared";
import {
  useMaskAntennaActions,
  useSafeReadyAntennasResource,
} from "./useMaskAntennaActions";

export {
  buildMaskAntennaSelection,
  type MaskAntennaTemplateDraft,
} from "./fieldDriveMaskShared";

/* ── Dedicated Mask Antenna Inspector Panel Hosted in Canonical InspectorTemplate ── */

export function FieldDriveMaskInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const editSessionStore = useInspectorEditSessionStore();
  const sessionScopeKey = kernel.commands.getSessionScopeKey?.() ?? null;

  const maskResource = maskAntennaResources.useMaskFieldDrivesResource();
  const regionalResource = useFieldDrivesResource();
  const readyAntennas = useSafeReadyAntennasResource();
  const scene = useSceneResource();

  const selectorOptions = useMemo(
    () => regionalFieldDriveSelectorOptions(scene.data ?? null),
    [scene.data],
  );
  const regionalIds = useMemo(
    () => extractDriveIds(regionalResource.data),
    [regionalResource.data],
  );
  const normalizedMaskData = useMemo(
    () => normalizeMaskListResource(maskResource.data, scene.data?.revision ?? null),
    [maskResource.data, scene.data?.revision],
  );

  const normalizedSelection = useMemo<Selection>(() => {
    if (selection.ref?.type === "physics-field-drive") return selection;
    const isDraftNode = Boolean(selection.nodeId?.includes(":draft"));
    const fallbackId = !isDraftNode ? (selection.nodeId?.split(":").at(-1) ?? undefined) : undefined;
    return {
      ...selection,
      ref: {
        ...(isDraftNode ? { draft: true } : {}),
        ...(fallbackId ? { fieldDriveId: fallbackId } : {}),
        fieldDriveKind: "mask",
        kind: "physics.field-drive",
        nodeId: selection.nodeId ?? "model:physics:mask-antenna:draft",
        type: "physics-field-drive",
      },
    };
  }, [selection]);

  const model = useMemo(() => {
    const resolved = resolveMaskAntennaPanelModel(
      normalizedSelection,
      normalizedMaskData,
      regionalIds,
    );
    if (resolved.mode === "create" && !resolved.drive) {
      const sourceObj =
        normalizedSelection.ref?.type === "physics-field-drive"
          ? normalizedSelection.ref.sourceObjectId
          : undefined;
      return {
        ...resolved,
        drive: createMaskAntennaDraft(regionalIds, sourceObj),
        sceneRevision: scene.data?.revision ?? null,
      };
    }
    return {
      ...resolved,
      sceneRevision: resolved.sceneRevision ?? scene.data?.revision ?? null,
    };
  }, [normalizedMaskData, normalizedSelection, regionalIds, scene.data?.revision]);

  const drive = model.drive;
  const identityKey =
    model.mode === "create"
      ? `${sessionScopeKey ?? "no-session"}:mask:create`
      : `${sessionScopeKey ?? "no-session"}:mask:${drive?.id ?? model.driveId ?? "none"}`;

  const [acknowledged, setAcknowledged] = useState<AcknowledgedMaskAntenna | null>(null);
  const [serverConflictDrive, setServerConflictDrive] = useState<{
    key: string;
    drive: MaskFieldDriveResource;
  } | null>(null);

  const activeServerOverride =
    serverConflictDrive?.key === identityKey ? serverConflictDrive.drive : null;

  const sceneDrive =
    model.mode === "found" &&
    acknowledged?.key === identityKey &&
    (model.sceneRevision ?? -1) < acknowledged.revision
      ? acknowledged.drive
      : drive;
  const effectiveSceneDrive = activeServerOverride ?? sceneDrive;

  const [draftState, setDraftState] = useState<MaskAntennaDraftState>(() => ({
    base: null,
    key: identityKey,
    value: null,
  }));
  const [rawState, setRawState] = useState<{ identityKey: string; values: RawInputs }>(() => ({
    identityKey,
    values: {},
  }));
  const [discardedSelection, setDiscardedSelection] = useState<Selection | null>(null);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(
    null,
  );
  const [appliedFlash, setAppliedFlash] = useState(false);
  const [newReadyFunction, setNewReadyFunction] = useState(UNSELECTED_READY_ANTENNA);
  const [codePreview, setCodePreview] = useState<{
    title: string;
    language: "python" | "json";
    code: string;
  } | null>(null);

  const editable = model.mode === "create" || model.mode === "found";
  const ownRaw = rawState.identityKey === identityKey ? rawState.values : {};
  const own = draftState.key === identityKey ? draftState.value : null;

  const merge =
    editable && own && model.mode === "found" && draftState.base && effectiveSceneDrive
      ? mergeMaskAntennaDraft(draftState.base, applyRawInputs(own, ownRaw), effectiveSceneDrive)
      : null;

  const draft = !editable
    ? null
    : merge
      ? merge.merged
      : own
        ? applyRawInputs(own, ownRaw)
        : effectiveSceneDrive
          ? applyRawInputs(structuredClone(effectiveSceneDrive), ownRaw)
          : null;

  const raw = draft ? consistentRawInputs(draft, ownRaw) : ownRaw;
  const conflicts = useMemo(() => merge?.conflicts ?? [], [merge?.conflicts]);
  const conflict = conflicts.length > 0;

  function editStart(): {
    base: MaskFieldDriveResource | null;
    raw: RawInputs;
    value: MaskFieldDriveResource;
  } | null {
    if (!own) {
      if (!effectiveSceneDrive) return null;
      return {
        base: model.mode === "found" ? structuredClone(effectiveSceneDrive) : null,
        raw: ownRaw,
        value: structuredClone(effectiveSceneDrive),
      };
    }
    if (
      merge &&
      effectiveSceneDrive &&
      merge.conflicts.length === 0 &&
      !sameJson(draftState.base, effectiveSceneDrive)
    ) {
      return {
        base: structuredClone(effectiveSceneDrive),
        raw,
        value: structuredClone(merge.merged),
      };
    }
    return { base: draftState.base, raw: ownRaw, value: own };
  }

  const setRaw = useCallback(
    (key: string, text: string): void => {
      const start = editStart();
      if (!start) return;
      setAppliedFlash(false);
      setFeedback(null);
      setDraftState({ base: start.base, key: identityKey, value: start.value });
      setRawState({ identityKey, values: { ...start.raw, [key]: text } });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveSceneDrive, identityKey, merge, model.mode, own, ownRaw, raw],
  );

  const setDraft = useCallback(
    (update: (value: MaskFieldDriveResource) => MaskFieldDriveResource): void => {
      const start = editStart();
      if (!start) return;
      setAppliedFlash(false);
      setFeedback(null);
      setDraftState({
        base: start.base,
        key: identityKey,
        value: update(applyRawInputs(start.value, start.raw)),
      });
      setRawState({ identityKey, values: {} });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveSceneDrive, identityKey, merge, model.mode, own, ownRaw, raw],
  );

  const keepDraft = useCallback((): void => {
    if (!merge || !effectiveSceneDrive) return;
    setDraftState({
      base: structuredClone(effectiveSceneDrive),
      key: identityKey,
      value: structuredClone(merge.merged),
    });
    setRawState({ identityKey, values: raw });
    setServerConflictDrive(null);
    setFeedback(null);
  }, [effectiveSceneDrive, identityKey, merge, raw]);

  const clearDraftState = useCallback((): void => {
    setDraftState({ base: null, key: identityKey, value: null });
    setRawState({ identityKey, values: {} });
    setServerConflictDrive(null);
  }, [identityKey]);

  const rawErrors = Object.keys(raw).flatMap((key) => rawError(raw, key) ?? []);
  const existingIdsExcludingCurrent = useMemo(() => {
    const taken = new Set<string>(regionalIds);
    for (const item of normalizedMaskData?.drives ?? []) {
      if (model.mode === "found" && item.id === model.driveId) continue;
      taken.add(item.id);
    }
    return taken;
  }, [model.driveId, model.mode, normalizedMaskData?.drives, regionalIds]);

  const validationErrors = useMemo(() => {
    if (!draft) return [...new Set(rawErrors)];
    const errs = [
      ...validateMaskAntennaDraft(draft),
      ...validateMaskLocalsAndStageActivation(draft),
      ...rawErrors,
    ];
    if (model.mode === "create" && existingIdsExcludingCurrent.has(draft.id.trim())) {
      errs.push(`An antenna or field drive with ID "${draft.id.trim()}" already exists.`);
    }
    return [...new Set(errs)];
  }, [draft, existingIdsExcludingCurrent, model.mode, rawErrors]);

  const dirty =
    Boolean(
      draft &&
        (model.mode === "create"
          ? own !== null || discardedSelection !== selection
          : effectiveSceneDrive && !sameJson(draft, effectiveSceneDrive)),
    ) || rawErrors.length > 0;

  const actions = useMaskAntennaActions({
    clearDraftState,
    conflict,
    dirty,
    draft,
    draftBase: draftState.base,
    drive,
    effectiveSceneDrive,
    identityKey,
    modelMode: model.mode,
    modelSceneRevision: model.sceneRevision,
    own,
    ownRaw,
    sceneData: scene.data ?? null,
    selection,
    sessionScopeKey,
    setAcknowledged,
    setAppliedFlash,
    setDraft,
    setFeedback,
    setNewReadyFunction,
    setServerConflictDrive,
    termsLocked: !draft || conflict,
    validationErrors,
  });

  const {
    buildReadyAntennaTerms,
    cancelReadyRequest,
    isSynchronouslyClean,
    onApplySave,
    onRemoveAntenna,
    pending,
    readyBusy,
  } = actions;

  const locked = !draft || pending;
  const termsLocked = locked || conflict;

  const resetDraft = useCallback(() => {
    cancelReadyRequest();
    clearDraftState();
    setFeedback(null);
    setAppliedFlash(false);
    setDiscardedSelection(selection);
  }, [cancelReadyRequest, clearDraftState, selection]);

  const dirtyFieldsSet = useMemo<ReadonlySet<string>>(
    () => computeMaskDirtyFields(draft, effectiveSceneDrive, model.mode, own, rawErrors.length),
    [draft, effectiveSceneDrive, model.mode, own, rawErrors.length],
  );

  const invalidFieldsMap = useMemo<ReadonlyMap<string, string>>(
    () => computeMaskInvalidFields(draft, validationErrors),
    [draft, validationErrors],
  );

  const selectionTargetKey =
    selection.nodeId ?? `physics.field-drive:mask:${model.driveId ?? "draft"}`;
  const registeredSessionKey = formatInspectorSessionKey(
    selectionTargetKey,
    "physics.field-drive.mask",
    "default",
  );

  const applyBlockReason = conflict
    ? SCENE_CHANGED_REASON
    : readyBusy
      ? READY_TERMS_PENDING_REASON
      : (validationErrors[0] ?? null);

  const lockReason = !editable
    ? "Selected mask antenna is not editable."
    : !sessionScopeKey
      ? "An active session is required to change this antenna."
      : readyBusy
        ? READY_TERMS_PENDING_REASON
        : conflict
          ? SCENE_CHANGED_REASON
          : null;

  const canApplySession = Boolean(
    draft &&
      sessionScopeKey &&
      model.sceneRevision !== null &&
      validationErrors.length === 0 &&
      !readyBusy &&
      !conflict,
  );

  const registeredSession = useMemo<InspectorEditSessionV2>(
    () => ({
      sessionKey: registeredSessionKey,
      nodeTitle: draft?.name || model.driveId || "Mask antenna",
      mode: "staged",
      applying: pending,
      get dirty() {
        return isSynchronouslyClean() ? false : dirty;
      },
      dirtyFields: dirtyFieldsSet,
      dirtyFieldLabels: Array.from(dirtyFieldsSet),
      invalidFields: invalidFieldsMap,
      valid: canApplySession,
      lockReason: !sessionScopeKey ? "An active session is required to change this antenna." : null,
      applyBlockReason,
      apply: onApplySave,
      revertAll: resetDraft,
      revertField: () => resetDraft(),
      focusField: () => undefined,
    }),
    [
      applyBlockReason,
      canApplySession,
      dirty,
      dirtyFieldsSet,
      draft?.name,
      invalidFieldsMap,
      isSynchronouslyClean,
      model.driveId,
      onApplySave,
      pending,
      registeredSessionKey,
      resetDraft,
      sessionScopeKey,
    ],
  );
  useRegisterInspectorEditSessionV2(registeredSession);

  // Keep store notified if synchronousCleanRef flips right before navigation.
  void editSessionStore;

  const templateBaseline = useMemo(
    () => toMaskTemplateDraft(effectiveSceneDrive),
    [effectiveSceneDrive],
  );
  const templateDraft = useMemo(() => toMaskTemplateDraft(draft), [draft]);

  const handleFieldChange = useCallback(
    <K extends keyof MaskAntennaTemplateDraft & string>(
      key: K,
      value: MaskAntennaTemplateDraft[K],
    ) => {
      if (locked) return;
      setDraft((d) => applyMaskTemplateFieldChange(d, key, value));
    },
    [locked, setDraft],
  );

  const registry = useMemo(
    () => readyAntennas.data?.antennas ?? [],
    [readyAntennas.data?.antennas],
  );
  const calls = useMemo(() => (draft ? readyAntennaCalls(draft) : []), [draft]);
  const newReadyAntenna = useMemo(
    () => registry.find((antenna) => antenna.function === newReadyFunction) ?? null,
    [newReadyFunction, registry],
  );

  const objectSelectOptions = useMemo(() => {
    const opts = [{ value: UNSELECTED_OBJECT, label: "Select an object" }];
    const seen = new Set<string>();
    for (const obj of selectorOptions.objects) {
      seen.add(obj.id);
      opts.push({ value: obj.id, label: obj.label });
    }
    const cur =
      draft && draft.target.kind !== "global" && draft.target.object_id
        ? draft.target.object_id
        : null;
    if (cur && !seen.has(cur)) {
      opts.push({ value: cur, label: cur });
    }
    return opts;
  }, [draft, selectorOptions.objects]);

  const regionSelectOptions = useMemo(() => {
    const opts = [{ value: UNSELECTED_REGION, label: "Select a region" }];
    const objId = draft && draft.target.kind !== "global" ? draft.target.object_id : "";
    const regions = selectorOptions.regionsByObject[objId] ?? [];
    const seen = new Set<string>();
    for (const reg of regions) {
      seen.add(reg.id);
      opts.push({ value: reg.id, label: reg.label });
    }
    const cur = draft?.target.kind === "region" ? draft.target.region_id : null;
    if (cur && !seen.has(cur)) {
      opts.push({ value: cur, label: cur });
    }
    return opts;
  }, [draft, selectorOptions.regionsByObject]);

  const stageToggleOptions = useMemo(
    () =>
      selectorOptions.timeEvolutionStages.map((st) => ({
        value: st.id,
        label: st.label,
      })),
    [selectorOptions.timeEvolutionStages],
  );

  const spec = useMemo<InspectorSpec<MaskAntennaTemplateDraft>>(
    () => ({
      id: "physics.field-drive.mask",
      header: {
        breadcrumbs: [
          {
            id: "drives",
            label: "Field Drives",
            selection: buildRootSelection(
              "physics.field-drives",
              "model:physics:field-drives",
              "Field Drives",
            ),
          },
          { id: "drive", label: draft?.name || model.driveId || "Mask antenna" },
        ],
        searchable: true,
        ...(model.mode === "found"
          ? {
              deleteAction: {
                label: "Delete Field Drive",
                confirmTitle: (d) => `Delete mask antenna "${d.name || d.id}"?`,
                confirmDescription:
                  "Deleting this mask antenna permanently removes its support volume and all analytic/sampled field terms from the session model.",
                onDelete: async () => {
                  await onRemoveAntenna();
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Radio,
        title: (d) => d.name || model.driveId || "Mask antenna",
        renameFieldKey: "name",
        kindLabel: "Spatial mask field drive",
        entityId: model.driveId ?? draft?.id,
        statePill: (d) =>
          model.mode === "create"
            ? { tone: "info", label: "Configured" }
            : model.mode === "found"
              ? d.enabled
                ? { tone: "ok", label: "Active" }
                : { tone: "degraded", label: "Disabled" }
              : { tone: "warn", label: "Not in scene" },
      },
      facts: buildMaskAntennaFacts,
      notices: () =>
        buildMaskAntennaNotices({
          conflict,
          conflicts,
          feedback,
          mode: model.mode,
        }),
      sections: buildMaskAntennaSections({
        buildReadyAntennaTerms,
        calls,
        conflict,
        draft,
        keepDraft,
        locked,
        modelDriveId: model.driveId ?? null,
        modelMode: model.mode,
        newReadyAntenna,
        newReadyFunction,
        objectSelectOptions,
        pending,
        raw,
        readyBusy,
        regionSelectOptions,
        registry,
        resetDraft,
        setDraft,
        setNewReadyFunction,
        setRaw,
        stageToggleOptions,
        termsLocked,
      }),
      commitBar: {
        mode: "staged",
        allowCleanApply: model.mode === "create" && discardedSelection !== selection,
        cleanMessage: () => "Mask antenna matches committed SceneDocument",
        lockReason: () => lockReason,
        onApply: onApplySave,
        onRevert: () => resetDraft(),
      },
    }),
    [
      buildReadyAntennaTerms,
      calls,
      conflict,
      conflicts,
      discardedSelection,
      draft,
      feedback,
      keepDraft,
      locked,
      lockReason,
      model.driveId,
      model.mode,
      newReadyAntenna,
      newReadyFunction,
      objectSelectOptions,
      onApplySave,
      onRemoveAntenna,
      pending,
      raw,
      readyBusy,
      regionSelectOptions,
      registry,
      resetDraft,
      selection,
      setDraft,
      setRaw,
      stageToggleOptions,
      termsLocked,
    ],
  );

  const emptyTouched = useMemo(() => new Set<string>(), []);

  return (
    <>
      <InspectorTemplate
        animationKey={`${selectionTargetKey}:mask`}
        appliedFlash={appliedFlash}
        appliedMessage={model.mode === "create" ? "Mask antenna created" : "Mask antenna saved"}
        applyError={feedback?.kind === "error" ? feedback.message : null}
        applying={pending}
        baseline={templateBaseline}
        dirtyFields={dirtyFieldsSet}
        draft={templateDraft}
        forceShowErrors={validationErrors.length > 0 && (dirty || model.mode === "create")}
        invalidFields={invalidFieldsMap}
        selection={selection}
        spec={spec}
        touchedFields={emptyTouched}
        onApply={onApplySave}
        onFieldChange={handleFieldChange}
        onFieldTouch={() => undefined}
        onFitView={(commandId) => {
          void kernel.commands.execute(
            commandId ?? "viewport-3d.fit-selection",
            createCommandContext("inspector", kernel),
          );
        }}
        onHideInspector={() => kernel.layout?.setPanelVisible?.("right", false)}
        onOpenCodePreview={(title, language, code) => setCodePreview({ title, language, code })}
        onRevertAll={resetDraft}
        onRevertField={() => resetDraft()}
        onSelectNode={(next) => kernel.selection.set(next, "inspector")}
      />

      <MaskCodePreviewDialog
        codePreview={codePreview}
        onClose={() => setCodePreview(null)}
      />
    </>
  );
}
