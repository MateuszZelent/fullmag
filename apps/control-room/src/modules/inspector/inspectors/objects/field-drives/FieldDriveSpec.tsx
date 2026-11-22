"use client";

import { Radio } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import {
  MODEL_FIELD_DRIVES_PATH,
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_SCENE_PATH,
} from "@/kernel/api/apiPaths";
import {
  captureAuthoringMutationFence,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { invalidateAuthoringMutationDependents } from "@/kernel/authoring/authoringMutationInvalidation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource } from "@/kernel/resources/fieldDriveResources";
import {
  publishCommittedSceneResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useMaskFieldDrivesResource } from "@/kernel/resources/maskAntennaResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { validateFieldDriveDraft } from "@/shared/domain/physics/fieldDrive";

import type { InspectorPanelProps } from "../../../inspectorTypes";
import {
  buildRootSelection,
  fallbackRevision,
  SpecInspectorHost,
} from "../../../panels/model-roots/SpecInspectorHost";
import {
  commitRegionalFieldDrive,
  createRegionalFieldDriveDraft,
  regionalFieldDriveSelectorOptions,
  resolveRegionalFieldDrivePanelModel,
} from "../../../panels/RegionalFieldDrivePanelModel";
import {
  type InspectorFact,
  type InspectorNotice,
  type InspectorSpec,
} from "../../../template";

import { FieldDriveMaskInspectorPanel } from "./FieldDriveMaskSpec";
import { buildFieldDriveSections } from "./FieldDriveSections";
import {
  buildCanonicalRegionalResourceFromDraft,
  estimateFieldDriveMaxFrequencyHz,
  extractDriveIds,
  hydrateRegionalDraftFromResource,
  normalizeRegionalListResource,
  resolveDraftNyquistHz,
  resolveStarterWaveformPreset,
  UNSELECTED_OBJECT,
  UNSELECTED_REGION,
  type FieldDriveSpecDraft,
} from "./fieldDriveShared";

export {
  createPiecewiseWaypoint,
  estimateFieldDriveMaxFrequencyHz,
  evaluateFieldDriveEnvelopeAtTime,
  type FieldDriveEnvelopeInput,
  type FieldDriveSpatialKind,
  type FieldDriveSpecDraft,
  type FieldDriveWaveformKind,
  type PiecewiseWaypointRow,
} from "./fieldDriveShared";

/* ── Regional Field Drive Panel Hosted in Canonical InspectorTemplate ── */

function RegionalFieldDriveInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const regionalResource = useFieldDrivesResource();
  const maskResource = useMaskFieldDrivesResource();

  const normalizedRegional = useMemo(
    () => normalizeRegionalListResource(regionalResource.data, scene.data?.revision ?? null),
    [regionalResource.data, scene.data?.revision],
  );
  const maskIds = useMemo(() => extractDriveIds(maskResource.data), [maskResource.data]);

  const normalizedSelection = useMemo<Selection>(() => {
    if (selection.ref?.type === "physics-field-drive") return selection;
    const isDraftNode = Boolean(selection.nodeId?.includes(":draft"));
    const fallbackId = !isDraftNode ? (selection.nodeId?.split(":").at(-1) ?? undefined) : undefined;
    return {
      ...selection,
      ref: {
        ...(isDraftNode ? { draft: true } : {}),
        ...(fallbackId ? { fieldDriveId: fallbackId } : {}),
        kind: "physics.field-drive",
        nodeId: selection.nodeId ?? "model:physics:field-drive:draft",
        type: "physics-field-drive",
      },
    };
  }, [selection]);

  const model = useMemo(() => {
    const resolved = resolveRegionalFieldDrivePanelModel(
      normalizedSelection,
      normalizedRegional,
    );
    const sourceObjectId =
      normalizedSelection.ref?.type === "physics-field-drive"
        ? normalizedSelection.ref.sourceObjectId
        : undefined;
    if (resolved.mode === "create") {
      const baseCreated = createRegionalFieldDriveDraft(
        normalizedRegional?.drives ?? [],
        sourceObjectId,
      );
      const takenIds = new Set([
        ...(normalizedRegional?.drives ?? []).map((item) => item.id),
        ...maskIds,
      ]);
      let uniqueId = baseCreated.id;
      if (takenIds.has(uniqueId)) {
        let suffix = 2;
        while (takenIds.has(`field-drive-${suffix}`)) {
          suffix += 1;
        }
        uniqueId = `field-drive-${suffix}`;
      }
      return {
        ...resolved,
        drive: uniqueId === baseCreated.id ? baseCreated : { ...baseCreated, id: uniqueId },
        sceneRevision: resolved.sceneRevision ?? scene.data?.revision ?? null,
      };
    }
    return {
      ...resolved,
      sceneRevision: resolved.sceneRevision ?? scene.data?.revision ?? null,
    };
  }, [maskIds, normalizedRegional, normalizedSelection, scene.data?.revision]);

  const presetWaveform = useMemo(
    () => (model.mode === "create" ? resolveStarterWaveformPreset(selection) : null),
    [model.mode, selection],
  );

  const selectorOptions = useMemo(
    () => regionalFieldDriveSelectorOptions(scene.data ?? null),
    [scene.data],
  );

  const existingIdsExcludingCurrent = useMemo(() => {
    const set = new Set<string>(maskIds);
    for (const item of normalizedRegional?.drives ?? []) {
      if (model.mode === "found" && item.id === model.driveId) continue;
      set.add(item.id);
    }
    return set;
  }, [maskIds, model.driveId, model.mode, normalizedRegional?.drives]);

  const baselineSignature = JSON.stringify([
    model.drive ?? null,
    model.mode,
    model.driveId ?? null,
    presetWaveform,
  ]);
  const baseline = useMemo<FieldDriveSpecDraft>(() => {
    if (model.drive) {
      return hydrateRegionalDraftFromResource(
        model.drive,
        model.mode === "found",
        presetWaveform,
      );
    }
    const fallbackDraft = createRegionalFieldDriveDraft([], undefined);
    return {
      ...hydrateRegionalDraftFromResource(fallbackDraft, false, presetWaveform),
      driveId: model.driveId ?? fallbackDraft.id,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselineSignature]);

  const selectionKey =
    selection.nodeId ??
    `physics.field-drive:regional:${model.mode === "create" ? "draft" : (model.driveId ?? "none")}`;

  const [scopedErrors, setScopedErrors] = useState<{
    key: string;
    conflictNotice: string | null;
    waypointParseError: string | null;
  }>({
    key: selectionKey,
    conflictNotice: null,
    waypointParseError: null,
  });

  const conflictNotice =
    scopedErrors.key === selectionKey ? scopedErrors.conflictNotice : null;
  const waypointParseError =
    scopedErrors.key === selectionKey ? scopedErrors.waypointParseError : null;

  const setConflictNotice = useCallback(
    (msg: string | null) => {
      setScopedErrors((prev) => ({
        key: selectionKey,
        conflictNotice: msg,
        waypointParseError: prev.key === selectionKey ? prev.waypointParseError : null,
      }));
    },
    [selectionKey],
  );
  const setWaypointParseError = useCallback(
    (msg: string | null) => {
      setScopedErrors((prev) => ({
        key: selectionKey,
        conflictNotice: prev.key === selectionKey ? prev.conflictNotice : null,
        waypointParseError: msg,
      }));
    },
    [selectionKey],
  );

  const sessionScopeKey = kernel.commands.getSessionScopeKey?.() ?? null;
  const editable = model.mode === "create" || model.mode === "found";

  const pendingNavigationRef = useRef<Omit<Selection, "moduleSource"> | null>(null);

  const handleApply = useCallback(
    async (d: FieldDriveSpecDraft): Promise<boolean> => {
      if (!editable) return false;
      if (d.stageScopeKind === "stage_ids" && d.selectedStageIds.length === 0) {
        throw new Error("Select at least one run stage.");
      }
      if (waypointParseError && d.waveformKind === "piecewise_linear") {
        throw new Error(waypointParseError);
      }
      const submitted = buildCanonicalRegionalResourceFromDraft(d);
      const domainErrors = validateFieldDriveDraft(submitted);
      if (domainErrors.length > 0) {
        throw new Error(domainErrors[0]!);
      }

      const context = captureAuthoringMutationFence(
        createCommandContext("inspector", kernel, {
          resourceData: scene.data ? { [MODEL_SCENE_PATH]: scene.data } : undefined,
          selection: typeof kernel.selection?.get === "function" ? kernel.selection : undefined,
          sourceDetail: "FieldDriveSpec.regional.save",
        }),
      );
      const scopeKey = context.sessionScopeKey;
      if (!scopeKey || context.isCurrentSessionScope?.() === false) {
        throw new Error("An active session is required to save this field drive.");
      }
      setConflictNotice(null);

      const writeMode = d.exists ? "found" : "create";

      try {
        const response = await runAuthoringMutationWithHistory(
          context,
          `${writeMode === "create" ? "Create" : "Update"} field drive ${submitted.id}`,
          ({ baseRevision }) => {
            const committedRevision =
              baseRevision ?? model.sceneRevision ?? scene.data?.revision ?? null;
            if (
              typeof committedRevision !== "number" ||
              !Number.isSafeInteger(committedRevision) ||
              committedRevision < 0
            ) {
              throw new Error(
                "The scene revision is unavailable. Refetch before changing the drive.",
              );
            }
            return commitRegionalFieldDrive(
              kernel.api.model,
              writeMode,
              committedRevision,
              submitted,
              { sessionScopeKey: scopeKey },
            );
          },
        );
        if (context.isCurrentSessionScope?.() === false) return false;
        const rev = response.scene_revision;
        if (response.committed_scene && typeof response.committed_scene === "object") {
          publishCommittedSceneResource(
            kernel.resources,
            response.committed_scene as Parameters<typeof publishCommittedSceneResource>[1],
            rev,
          );
        }
        kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, rev);
        kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, fallbackRevision(rev));
        invalidateAuthoringMutationDependents(kernel.resources, "interaction", rev);

        if (writeMode === "create") {
          const nodeId = `model:physics:field-drives:${submitted.id}`;
          pendingNavigationRef.current = {
            kind: "physics.field-drive",
            label: submitted.name || submitted.id,
            nodeId,
            objectId: null,
            ref: {
              fieldDriveId: submitted.id,
              kind: "physics.field-drive",
              nodeId,
              type: "physics-field-drive",
            },
          };
        }
        return true;
      } catch (error) {
        if (context.isCurrentSessionScope?.() === false) return false;
        const status = (error as { status?: number } | null)?.status;
        const msg = error instanceof Error ? error.message : String(error);
        if (status === 409 || /conflict|revision/i.test(msg)) {
          kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, fallbackRevision(undefined));
          kernel.resources.invalidate(MODEL_SCENE_PATH, fallbackRevision(undefined));
          setConflictNotice(
            "Scene revision changed concurrently while saving. Reload the latest scene version or apply again.",
          );
        }
        throw error instanceof Error ? error : new Error(msg);
      }
    },
    [editable, kernel, model.sceneRevision, scene.data, setConflictNotice, waypointParseError],
  );

  const lockReason = !editable
    ? "Selected field drive is not present in the current scene."
    : !sessionScopeKey
      ? "An active session is required to modify this field drive."
      : null;

  const handleDelete = useCallback(
    async (d: FieldDriveSpecDraft) => {
      if (!d.exists || !d.driveId) return;
      const context = captureAuthoringMutationFence(
        createCommandContext("inspector", kernel, {
          resourceData: scene.data ? { [MODEL_SCENE_PATH]: scene.data } : undefined,
          selection: typeof kernel.selection?.get === "function" ? kernel.selection : undefined,
          sourceDetail: "FieldDriveSpec.regional.delete",
        }),
      );
      const scopeKey = context.sessionScopeKey;
      const ack = await runAuthoringMutationWithHistory(
        context,
        `Delete field drive ${d.driveId}`,
        ({ baseRevision }) => {
          const committedRevision =
            baseRevision ?? model.sceneRevision ?? scene.data?.revision ?? null;
          return kernel.api.model.deleteFieldDrive(
            d.driveId,
            { base_revision: committedRevision },
            scopeKey ? { sessionScopeKey: scopeKey } : undefined,
          );
        },
      );
      if (context.isCurrentSessionScope?.() === false) return;
      const rev = ack?.scene_revision;
      if (ack?.committed_scene && typeof ack.committed_scene === "object") {
        publishCommittedSceneResource(
          kernel.resources,
          ack.committed_scene as Parameters<typeof publishCommittedSceneResource>[1],
          rev,
        );
      }
      kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, rev);
      kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
      kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, fallbackRevision(rev));
      invalidateAuthoringMutationDependents(kernel.resources, "interaction", rev);
      kernel.selection.set(
        buildRootSelection("physics.field-drives", "model:physics:field-drives", "Field Drives"),
        "inspector",
      );
    },
    [kernel, model.sceneRevision, scene.data],
  );

  const objectSelectOptions = useMemo(() => {
    const opts = [{ value: UNSELECTED_OBJECT, label: "Select an object" }];
    const seen = new Set<string>();
    for (const obj of selectorOptions.objects) {
      seen.add(obj.id);
      opts.push({ value: obj.id, label: obj.label });
    }
    for (const candidate of [baseline.targetObjectId, baseline.maskObjectId]) {
      if (candidate && candidate !== UNSELECTED_OBJECT && !seen.has(candidate)) {
        seen.add(candidate);
        opts.push({ value: candidate, label: candidate });
      }
    }
    return opts;
  }, [baseline.maskObjectId, baseline.targetObjectId, selectorOptions.objects]);

  const regionSelectOptions = useMemo(() => {
    const opts = [{ value: UNSELECTED_REGION, label: "Select a region" }];
    const seen = new Set<string>();
    for (const regions of Object.values(selectorOptions.regionsByObject)) {
      for (const reg of regions) {
        if (!seen.has(reg.id)) {
          seen.add(reg.id);
          opts.push({ value: reg.id, label: reg.label });
        }
      }
    }
    const cur = baseline.targetRegionId;
    if (cur && cur !== UNSELECTED_REGION && !seen.has(cur)) {
      opts.push({ value: cur, label: cur });
    }
    return opts;
  }, [baseline.targetRegionId, selectorOptions.regionsByObject]);

  const stageOptions = useMemo(
    () =>
      selectorOptions.timeEvolutionStages.map((st) => ({
        value: st.id,
        label: st.label,
      })),
    [selectorOptions.timeEvolutionStages],
  );

  const spec = useMemo<InspectorSpec<FieldDriveSpecDraft>>(
    () => ({
      id: "physics.field-drive",
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
          { id: "drive", label: baseline.name || baseline.driveId },
        ],
        searchable: true,
        ...(baseline.exists
          ? {
              deleteAction: {
                label: "Delete Field Drive",
                confirmTitle: (d) => `Delete field drive "${d.name}"?`,
                confirmDescription:
                  "Deleting this field drive permanently removes its spatial-temporal excitation profile from all study stages.",
                onDelete: async (ctx) => {
                  await handleDelete(ctx.draft);
                },
              },
            }
          : {}),
      },
      identity: {
        domain: "physics",
        icon: Radio,
        title: (d) => d.name || d.driveId,
        renameFieldKey: "name",
        kindLabel: "Regional external field drive",
        entityId: baseline.driveId,
        statePill: (d) =>
          !editable
            ? { tone: "warn", label: "Not in scene" }
            : !d.exists
              ? { tone: "info", label: "Configured" }
              : d.enabled
                ? { tone: "ok", label: "Active" }
                : { tone: "degraded", label: "Disabled" },
      },
      facts: (d): readonly InspectorFact[] => {
        const maxFreqGhz = estimateFieldDriveMaxFrequencyHz(d) * 1e-9;
        return [
          {
            id: "peak",
            label: "Peak |B|",
            value: `${(d.amplitudeBT * 1e3).toFixed(2)} mT`,
          },
          {
            id: "waveform",
            label: "Waveform",
            value: d.waveformKind.replace(/_/g, " "),
          },
          {
            id: "fmax",
            label: "Max f",
            value: maxFreqGhz > 0 ? `${maxFreqGhz.toFixed(2)} GHz` : "DC",
          },
          {
            id: "spatial",
            label: "Spatial",
            value: d.spatialKind.replace(/_/g, " "),
          },
        ];
      },
      notices: (d): readonly InspectorNotice<FieldDriveSpecDraft>[] => {
        const list: InspectorNotice<FieldDriveSpecDraft>[] = [];
        if (!editable) {
          list.push({
            id: "regional-missing",
            tone: "warn",
            title: "Field drive not found in scene",
            text: "Select an existing field drive from Field Drives or create a new excitation.",
          });
        }
        if (conflictNotice) {
          list.push({
            id: "regional-conflict",
            tone: "warn",
            title: "Concurrent scene update",
            text: conflictNotice,
            quickFix: {
              label: "Reload latest version",
              onApply: (ctx) => {
                kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, fallbackRevision(undefined));
                kernel.resources.invalidate(MODEL_SCENE_PATH, fallbackRevision(undefined));
                setConflictNotice(null);
                ctx.patchDraft(baseline);
              },
            },
          });
        }
        const nyquistHz = resolveDraftNyquistHz(scene.data ?? null, d);
        const maxFreqHz = estimateFieldDriveMaxFrequencyHz(d);
        if (nyquistHz !== null && maxFreqHz > nyquistHz) {
          list.push({
            id: "nyquist-aliasing",
            tone: "warn",
            title: "Excitation exceeds output Nyquist frequency",
            text: `Drive spectral content reaches ${(maxFreqHz * 1e-9).toFixed(2)} GHz, above the saved output Nyquist limit f_Nyq = ${(nyquistHz * 1e-9).toFixed(2)} GHz.`,
            focusFieldKey:
              d.waveformKind === "sinc_pulse" ? "cutoffFreqHz" : "carrierFreqHz",
            quickFix:
              d.waveformKind === "sinc_pulse"
                ? {
                    label: "Clamp to Nyquist",
                    onApply: (ctx) => ctx.setField("cutoffFreqHz", 0.8 * nyquistHz),
                  }
                : undefined,
          });
        }
        return list;
      },
      sections: buildFieldDriveSections({
        existingIdsExcludingCurrent,
        objectSelectOptions,
        regionSelectOptions,
        scene: scene.data ?? null,
        setWaypointParseError,
        stageOptions,
      }),
      commitBar: {
        mode: "staged",
        allowCleanApply: (d) => !d.exists,
        cleanMessage: () => "Field drive matches committed SceneDocument",
        lockReason: () => lockReason,
        onApply: async (d) => {
          pendingNavigationRef.current = null;
          return handleApply(d);
        },
        onRevert: () => {
          setConflictNotice(null);
          setWaypointParseError(null);
        },
      },
    }),
    [
      baseline,
      conflictNotice,
      editable,
      existingIdsExcludingCurrent,
      handleApply,
      handleDelete,
      kernel.resources,
      lockReason,
      objectSelectOptions,
      regionSelectOptions,
      scene.data,
      setConflictNotice,
      setWaypointParseError,
      stageOptions,
    ],
  );

  const hostOptions = useMemo(
    () => ({
      onApplied: () => {
        if (pendingNavigationRef.current) {
          const target = pendingNavigationRef.current;
          pendingNavigationRef.current = null;
          kernel.selection.set(target, "inspector");
        }
      },
    }),
    [kernel.selection],
  );

  return (
    <SpecInspectorHost
      baseline={baseline}
      options={hostOptions}
      selection={selection}
      spec={spec}
    />
  );
}

/* ── Top-Level Router: Mask Antenna vs Regional Field Drive ── */

export function FieldDriveInspectorPanel({ selection }: InspectorPanelProps) {
  const regionalResource = useFieldDrivesResource();
  const maskResource = useMaskFieldDrivesResource();

  const driveRef =
    selection.ref?.type === "physics-field-drive" ? selection.ref : null;
  const explicitMask =
    driveRef?.fieldDriveKind === "mask" ||
    Boolean(selection.nodeId?.startsWith("model:physics:mask-antenna")) ||
    Boolean(selection.nodeId?.endsWith(":mask"));

  const isDraft = Boolean(driveRef?.draft) || Boolean(selection.nodeId?.includes(":draft"));
  const requestedId =
    driveRef?.fieldDriveId ??
    (!isDraft ? (selection.nodeId?.split(":").at(-1) ?? null) : null);

  const regionalIds = useMemo(
    () => new Set(extractDriveIds(regionalResource.data)),
    [regionalResource.data],
  );
  const maskIds = useMemo(
    () => new Set(extractDriveIds(maskResource.data)),
    [maskResource.data],
  );

  const isMask =
    explicitMask ||
    (!isDraft &&
      Boolean(requestedId) &&
      !regionalIds.has(requestedId!) &&
      maskIds.has(requestedId!));

  if (isMask) {
    return <FieldDriveMaskInspectorPanel selection={selection} />;
  }
  return <RegionalFieldDriveInspectorPanel selection={selection} />;
}
