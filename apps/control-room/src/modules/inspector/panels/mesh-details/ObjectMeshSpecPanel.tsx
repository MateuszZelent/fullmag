"use client";

import {
  Activity,
  Box,
  Gauge,
  Grid3x3,
  History,
  Layers,
  Ruler,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { JsonObject } from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import * as meshPolicyResourceCache from "@/kernel/resources/meshPolicyResourceCache";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import * as sessionStatusHooks from "@/kernel/resources/useSessionStatus";
import {
  normalizeMeshBuildHistory,
  type MeshBuildHistoryEntry,
} from "@/shared/domain/mesh/meshBuildHistory";
import { normalizeMeshQualityStatistics } from "@/shared/domain/mesh/qualityStatistics";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorNotice, InspectorSpec } from "../../template";
import {
  resolveFdmObjectMeshInspectorModel,
  type FdmObjectMeshInspectorResources,
} from "../fdmMeshInspectorModel";
import type { MeshSizeDistributionHoverBin } from "../MeshQualityChart";
import { asRecord, recordField } from "../MeshResourceView";
import { emitMeshSizeHistogramHover } from "../meshSizeHistogramHover";
import {
  buildObjectMeshPolicyReplaceRequest,
  clearObjectMeshStrategyFromConfig,
  draftFromObjectMeshPolicyResource,
  nodePlaneCount,
  objectMeshPolicyJsonError,
  resolveObjectMeshTopologyCapabilities,
  updateObjectMeshPolicyDraft,
  validateObjectMeshTopologyCapabilities,
  type ObjectMeshPolicyDraft,
} from "../ObjectMeshPolicyPanelModel";
import {
  formatCountClean,
  MeshBuildHistorySpecView,
  MeshQualityStatisticsSpecView,
  sanitizeMeshDisplayText,
} from "./MeshQualityAndHistorySpecViews";
import { SpecInspectorHost } from "./SpecInspectorHost";

function safeModField<M extends object, K extends keyof M>(
  mod: M,
  key: K,
): M[K] | undefined {
  return key in mod ? mod[key] : undefined;
}

const SESSION_STATUS_KEY =
  safeModField(sessionStatusHooks, "SESSION_STATUS_RESOURCE_KEY") ??
  "/session/status";

const useSafeObjectMeshReportResource =
  safeModField(geometryLifecycleResources, "useObjectMeshReportResource") ??
  ((_id: string | null | undefined, _opts?: { enabled?: boolean }) =>
    emptyResource<{ report?: unknown }>());
const useSafeObjectMeshSizeFieldResource =
  safeModField(geometryLifecycleResources, "useObjectMeshSizeFieldResource") ??
  ((_id: string | null | undefined, _opts?: { enabled?: boolean }) =>
    emptyResource<{ size_field?: unknown }>());
const useSafeObjectTopologyResource =
  safeModField(geometryLifecycleResources, "useObjectTopologyResource") ??
  ((_id: string | null | undefined, _opts?: { enabled?: boolean }) =>
    emptyResource<{
      boundaryFaceCount?: number;
      elementCount?: number;
      nodeCount?: number;
    }>());
const useSafeMeshCapabilitiesResource =
  safeModField(geometryLifecycleResources, "useMeshCapabilitiesResource") ??
  ((_opts?: { enabled?: boolean }) =>
    emptyResource<{ mesh_capabilities?: Record<string, unknown> }>());
const useSafeMeshBuildHistoryResource =
  safeModField(geometryLifecycleResources, "useMeshBuildHistoryResource") ??
  ((_opts?: { enabled?: boolean }) =>
    emptyResource<{ entries?: unknown[]; history?: unknown }>());
const useSafeFdmRegionMembershipResource =
  safeModField(geometryLifecycleResources, "useFdmRegionMembershipResource") ??
  ((_opts?: { enabled?: boolean }) => emptyResource<never>());
const useSafeFdmRegionMembershipBinaryResource =
  safeModField(
    geometryLifecycleResources,
    "useFdmRegionMembershipBinaryResource",
  ) ??
  ((_url?: string, _opts?: { enabled?: boolean }) => emptyResource<never>());

function emptyResource<T>() {
  return {
    data: null as T | null,
    error: null,
    refetch: () => Promise.resolve(null),
    revision: 0,
    status: "ready" as const,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatLengthSmartLocal(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return null;
  const abs = Math.abs(meters);
  if (abs === 0) return "0 nm";
  if (abs < 1e-6) return `${Number((meters * 1e9).toFixed(2))} nm`;
  if (abs < 1e-3) return `${Number((meters * 1e6).toFixed(2))} µm`;
  if (abs < 1) return `${Number((meters * 1e3).toFixed(3))} mm`;
  return `${Number(meters.toFixed(4))} m`;
}

export interface ObjectMeshSpecDraft extends ObjectMeshPolicyDraft {
  policyMode: "inherit" | "custom";
}

function toSpecDraft(draft: ObjectMeshPolicyDraft): ObjectMeshSpecDraft {
  return {
    ...draft,
    policyMode: draft.present ? "custom" : "inherit",
  };
}

const MESH_SIZE_CALIBRATIONS: readonly { label: string; value: string }[] = [
  { label: "Inherited", value: "" },
  { label: "General physics", value: "general_physics" },
  { label: "Micromagnetics static", value: "micromagnetics_static" },
  { label: "Micromagnetics relaxation", value: "micromagnetics_relaxation" },
  { label: "Micromagnetics frequency domain", value: "micromagnetics_frequency_domain" },
  { label: "Magnetostatics dominated", value: "magnetostatics_dominated" },
  { label: "Imported surface cleanup", value: "imported_surface_cleanup" },
];

const MESH_SIZE_PRESETS: readonly { label: string; value: string }[] = [
  { label: "Inherited", value: "" },
  { label: "Extremely fine", value: "extremely_fine" },
  { label: "Extra fine", value: "extra_fine" },
  { label: "Finer", value: "finer" },
  { label: "Fine", value: "fine" },
  { label: "Normal", value: "normal" },
  { label: "Coarse", value: "coarse" },
  { label: "Coarser", value: "coarser" },
  { label: "Extra coarse", value: "extra_coarse" },
  { label: "Extremely coarse", value: "extremely_coarse" },
];

function useActiveMeshLane(): "fdm" | "fem" | "unresolved" {
  const raw = sessionStatusHooks.useSessionStatusSelector(
    (status) => status.data?.domain?.discretization ?? null,
  );
  if (typeof raw !== "string") return "unresolved";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "fdm") return "fdm";
  if (normalized === "fem") return "fem";
  return "unresolved";
}

export function ObjectMeshInspectorSpecPanel({
  selection,
}: InspectorPanelProps): ReactNode {
  const kernel = useKernel();
  const sessionScopeKey =
    sessionRequestScopeKey(sessionStatusHooks.useSessionResourceIdentity()) ?? undefined;
  const activeLane = useActiveMeshLane();
  const fdmMode = activeLane === "fdm";
  const femMode = activeLane === "fem";

  const objectId =
    selection.objectId ?? asString(asRecord(selection.ref)?.objectId) ?? "";

  const scene = geometryLifecycleResources.useSceneResource({
    enabled: Boolean(objectId),
  });
  const policyRes = geometryLifecycleResources.useObjectMeshPolicyResource(objectId, {
    enabled: Boolean(objectId) && femMode,
  });
  const qualityRes = geometryLifecycleResources.useObjectMeshQualityResource(objectId, {
    enabled: Boolean(objectId) && femMode,
  });
  const reportRes = useSafeObjectMeshReportResource(objectId, {
    enabled: Boolean(objectId) && femMode,
  });
  const sizeFieldRes = useSafeObjectMeshSizeFieldResource(objectId, {
    enabled: Boolean(objectId) && femMode,
  });
  const topologyRes = useSafeObjectTopologyResource(objectId, {
    enabled: Boolean(objectId) && femMode,
  });
  const capabilitiesRes = useSafeMeshCapabilitiesResource({ enabled: femMode });
  const buildHistoryRes = useSafeMeshBuildHistoryResource({ enabled: femMode });

  const fdmDomain = geometryLifecycleResources.useDomainMetaResource({
    enabled: fdmMode,
  });
  const fdmMembership = useSafeFdmRegionMembershipResource({
    enabled: fdmMode,
  });
  const fdmMembershipBinary = useSafeFdmRegionMembershipBinaryResource(
    undefined,
    { enabled: fdmMode },
  );

  const fdmModel = useMemo(() => {
    if (!fdmMode) return null;
    const resources: FdmObjectMeshInspectorResources = {
      binary: fdmMembershipBinary as FdmObjectMeshInspectorResources["binary"],
      domain: fdmDomain,
      membership: fdmMembership as FdmObjectMeshInspectorResources["membership"],
    };
    return resolveFdmObjectMeshInspectorModel({
      lane: "fdm",
      objectId,
      resources,
    });
  }, [fdmDomain, fdmMembership, fdmMembershipBinary, fdmMode, objectId]);

  const sceneObject = useMemo(() => {
    const objs = Array.isArray(scene.data?.objects) ? scene.data.objects : [];
    return objs.map(asRecord).find((obj) => asString(obj?.id) === objectId) ?? null;
  }, [objectId, scene.data]);

  const objectName = asString(sceneObject?.name) ?? (objectId || "Object");
  const geometryRec = asRecord(sceneObject?.geometry);
  const geometryKind =
    asString(geometryRec?.geometry_kind) ?? asString(geometryRec?.kind) ?? "Primitive";

  const reportRecord = asRecord(asRecord(reportRes.data)?.report);
  const effectiveTarget = asRecord(
    recordField(reportRecord, "effective_target"),
  ) as JsonObject | null;

  const resource = useMemo(
    () =>
      policyRes.data ?? {
        config: null,
        effective_config: null,
        object_id: objectId,
        revision: 0,
      },
    [objectId, policyRes.data],
  );

  const baseline = useMemo<ObjectMeshSpecDraft>(() => {
    const rawDraft = draftFromObjectMeshPolicyResource(resource, {
      effectiveTarget,
    });
    return toSpecDraft(rawDraft);
  }, [effectiveTarget, resource]);

  const [restoredOverrides, setRestoredOverrides] =
    useState<Partial<ObjectMeshSpecDraft> | undefined>(undefined);
  const [statusFeedback, setStatusFeedback] = useState<{
    tone: "info" | "warn" | "err";
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!kernel?.bus?.on || !femMode || !objectId) return;
    const offRestore = kernel.bus.on("mesh:build-history-restore-requested", (event) => {
      if (event.meshTarget !== null && !event.meshTarget.endsWith(`:${objectId}`)) {
        return;
      }
      const objectSnapshots = asRecord(event.snapshot?.objects);
      if (!objectSnapshots || !Object.hasOwn(objectSnapshots, objectId)) return;
      const snapshotValue = objectSnapshots[objectId];
      const objectSnapshot = snapshotValue === null ? null : asRecord(snapshotValue);
      if (snapshotValue !== null && !objectSnapshot) return;
      const restored = toSpecDraft(
        draftFromObjectMeshPolicyResource(
          { ...resource, config: objectSnapshot as JsonObject | null },
          { effectiveTarget },
        ),
      );
      setRestoredOverrides(restored);
      setStatusFeedback({
        text: `Build ${event.buildId ?? event.entryId} restored into draft. Click Apply to persist.`,
        tone: "info",
      });
    });
    if (policyRes.status === "ready") {
      kernel.bus.emit?.("mesh:build-history-editor-ready", {
        target: `object:${objectId}`,
      });
    }
    return () => {
      offRestore();
    };
  }, [
    effectiveTarget,
    femMode,
    kernel.bus,
    objectId,
    policyRes.status,
    resource,
  ]);

  const topologyCapabilities = useMemo(
    () =>
      resolveObjectMeshTopologyCapabilities(
        capabilitiesRes.data as Parameters<
          typeof resolveObjectMeshTopologyCapabilities
        >[0],
      ),
    [capabilitiesRes.data],
  );

  const qualityRaw =
    asRecord(qualityRes.data)?.quality ?? asRecord(qualityRes.data) ?? null;
  const qualityStatistics = useMemo(
    () => normalizeMeshQualityStatistics(qualityRaw),
    [qualityRaw],
  );

  const realizedObjectSizeFields = useMemo(() => {
    const sizeFieldRecord = asRecord(asRecord(sizeFieldRes.data)?.size_field);
    return Array.isArray(recordField(sizeFieldRecord, "size_fields"))
      ? (recordField(sizeFieldRecord, "size_fields") as unknown[])
      : [];
  }, [sizeFieldRes.data]);
  const sizeFieldKinds = useMemo(() => {
    const kinds: string[] = [];
    for (const entry of realizedObjectSizeFields) {
      const k = asString(asRecord(entry)?.kind);
      if (k) kinds.push(k);
    }
    return kinds;
  }, [realizedObjectSizeFields]);

  const buildHistoryEntries = useMemo(() => {
    const rawHistory =
      asRecord(buildHistoryRes.data)?.history ??
      asRecord(buildHistoryRes.data)?.entries ??
      buildHistoryRes.data;
    const all = normalizeMeshBuildHistory(rawHistory);
    if (!objectId) return all;
    return all.filter((entry) => {
      if (!entry.meshTarget || entry.meshTarget === "all") return true;
      if (
        entry.meshTarget === `object:${objectId}` ||
        entry.meshTarget === `object_mesh:${objectId}`
      ) {
        return true;
      }
      const objectSnapshots = asRecord(entry.canonicalPolicySnapshot?.objects);
      return objectSnapshots ? Object.hasOwn(objectSnapshots, objectId) : false;
    });
  }, [buildHistoryRes.data, objectId]);

  const commandContext = useMemo(
    () =>
      createCommandContext("inspector", kernel, {
        sessionScopeKey: sessionScopeKey ?? null,
        sourceDetail: "object.mesh",
      }),
    [kernel, sessionScopeKey],
  );

  const persistObjectPolicy = useCallback(
    async (draft: ObjectMeshSpecDraft): Promise<boolean> => {
      if (!objectId) return false;
      const synced: ObjectMeshPolicyDraft = {
        ...draft,
        present: draft.policyMode === "custom",
      };
      if (synced.present) {
        const capErr = validateObjectMeshTopologyCapabilities(
          synced,
          topologyCapabilities,
        );
        if (capErr) {
          throw new Error(capErr);
        }
      }
      const built = buildObjectMeshPolicyReplaceRequest(synced);
      if ("error" in built) {
        throw new Error(built.error);
      }
      const wireRequest = built.request.config
        ? {
            ...built.request,
            config: { ...built.request.config, mode: "custom" } as JsonObject,
          }
        : { config: null };

      const next = await kernel.api.meshing.replaceObjectPolicy(
        objectId,
        wireRequest,
        sessionScopeKey ? { sessionScopeKey } : undefined,
      );
      const nextRev = typeof next?.revision === "number" ? next.revision : `w5:${Date.now()}`;
      if (sessionScopeKey && next && typeof next.revision === "number") {
        meshPolicyResourceCache.publishCommittedMeshPolicyResource?.(
          kernel.resources,
          geometryLifecycleResources.resolveObjectMeshPolicyResourceKey(objectId),
          sessionScopeKey,
          next,
          kernel.api.resourceCacheScope,
        );
      }
      kernel.resources.invalidate(
        geometryLifecycleResources.resolveObjectMeshPolicyResourceKey(objectId),
        nextRev,
      );
      const resolveReportKey = safeModField(
        geometryLifecycleResources,
        "resolveObjectMeshReportResourceKey",
      );
      if (resolveReportKey) {
        kernel.resources.invalidate(resolveReportKey(objectId), nextRev);
      }
      const resolveQualityKey = safeModField(
        geometryLifecycleResources,
        "resolveObjectMeshQualityResourceKey",
      );
      if (resolveQualityKey) {
        kernel.resources.invalidate(resolveQualityKey(objectId), nextRev);
      }
      const buildCurrentKey = safeModField(
        geometryLifecycleResources,
        "MESH_BUILD_CURRENT_RESOURCE_KEY",
      );
      if (buildCurrentKey) {
        kernel.resources.invalidate(buildCurrentKey, nextRev);
      }
      const buildLatestKey = safeModField(
        geometryLifecycleResources,
        "MESH_BUILD_LATEST_SUCCESSFUL_RESOURCE_KEY",
      );
      if (buildLatestKey) {
        kernel.resources.invalidate(buildLatestKey, nextRev);
      }
      kernel.resources.invalidate(
        geometryLifecycleResources.MESH_SEMANTICS_RESOURCE_KEY,
        nextRev,
      );
      kernel.resources.invalidate(
        geometryLifecycleResources.SCENE_RESOURCE_KEY,
        nextRev,
      );
      kernel.resources.invalidate(
        SESSION_STATUS_KEY,
        `mesh-policy:object:${objectId}:${String(nextRev)}`,
      );
      setRestoredOverrides(undefined);
      return true;
    },
    [
      kernel.api.meshing,
      kernel.api.resourceCacheScope,
      kernel.resources,
      objectId,
      sessionScopeKey,
      setRestoredOverrides,
      topologyCapabilities,
    ],
  );

  const runMeshBuildCommand = useCallback(
    async (
      commandId: "mesh.build-selected" | "mesh.build-shared-domain",
      currentDraft: ObjectMeshSpecDraft,
      baseDraft: ObjectMeshSpecDraft,
    ) => {
      if (JSON.stringify(currentDraft) !== JSON.stringify(baseDraft)) {
        await persistObjectPolicy(currentDraft);
      }
      await kernel.commands.execute(commandId, commandContext);
    },
    [commandContext, kernel.commands, persistObjectPolicy],
  );

  const hoverSizeDistributionBin = useCallback(
    (bin: MeshSizeDistributionHoverBin | null) => {
      emitMeshSizeHistogramHover({
        bin,
        kernel,
        scope: objectId ? { kind: "object", objectId } : { kind: "all" },
      });
    },
    [kernel, objectId],
  );

  const handleAfterFieldChange = useCallback(
    <K extends keyof ObjectMeshSpecDraft & string>(
      key: K,
      value: ObjectMeshSpecDraft[K],
      helpers: {
        draft: ObjectMeshSpecDraft;
        patchDraft: (partial: Partial<ObjectMeshSpecDraft>) => void;
      },
    ) => {
      if (key === "policyMode") {
        const present = value === "custom";
        const updated = updateObjectMeshPolicyDraft(
          { ...helpers.draft, present },
          { present },
        );
        helpers.patchDraft(toSpecDraft(updated));
        return;
      }
      if (key === "meshStrategy") {
        const nextStrategy = String(value ?? "");
        const strategyPatch: Partial<ObjectMeshPolicyDraft> =
          nextStrategy === "swept_prism"
            ? {
                exactLayerCount: "true",
                meshStrategy: "swept_prism",
                order: "1",
                sweepFaceMeshing: "triangular",
                throughThicknessDistribution: "fixed",
                throughThicknessElementRatio: "1",
                throughThicknessElements: "1",
                throughThicknessSymmetric: "false",
                topology: "prismatic",
                transitionPolicy: "pyramid_to_tetrahedra",
              }
            : {
                configText: clearObjectMeshStrategyFromConfig(
                  helpers.draft.configText,
                ),
                exactLayerCount: "",
                meshStrategy: nextStrategy,
                sweepFaceMeshing: "",
                throughThicknessDistribution: "",
                throughThicknessElementRatio: "",
                throughThicknessElements: "",
                throughThicknessSymmetric: "",
                topology: "",
                transitionPolicy: "",
              };
        const updated = updateObjectMeshPolicyDraft(
          { ...helpers.draft, present: helpers.draft.policyMode === "custom" },
          strategyPatch,
        );
        helpers.patchDraft(toSpecDraft(updated));
        return;
      }
      const updated = updateObjectMeshPolicyDraft(
        { ...helpers.draft, present: helpers.draft.policyMode === "custom" },
        { [key]: value } as Partial<ObjectMeshPolicyDraft>,
      );
      if (updated.configText !== helpers.draft.configText) {
        helpers.patchDraft({
          configSynchronized: updated.configSynchronized,
          configText: updated.configText,
          syncedConfigText: updated.syncedConfigText,
        });
      }
    },
    [],
  );

  const spec = useMemo<InspectorSpec<ObjectMeshSpecDraft>>(() => {
    const realizedElements =
      qualityStatistics?.elementCount ??
      asNumber(topologyRes.data?.elementCount) ??
      asNumber(asRecord(qualityRes.data)?.element_count);
    const customDisabled = (d: ObjectMeshSpecDraft) =>
      d.policyMode !== "custom"
        ? "Switch Policy ownership to Custom object policy to edit per-object mesh parameters."
        : null;
    const studyFdm = asRecord(asRecord(asRecord(scene.data)?.study)?.fdm);
    const authoredDefaultCell =
      Array.isArray(studyFdm?.default_cell) && studyFdm.default_cell.length >= 3
        ? (studyFdm.default_cell as unknown[]).map(asNumber)
        : null;
    const hasAuthoredFdmCell = Boolean(
      authoredDefaultCell && authoredDefaultCell.every((v) => v !== null && v > 0),
    );
    const authoredCellLabel =
      hasAuthoredFdmCell && authoredDefaultCell
        ? `${Number(((authoredDefaultCell[0] ?? 0) * 1e9).toFixed(2))} × ${Number(((authoredDefaultCell[1] ?? 0) * 1e9).toFixed(2))} × ${Number(((authoredDefaultCell[2] ?? 0) * 1e9).toFixed(2))} nm`
        : null;
    const fdmGridMissing =
      fdmMode &&
      (!fdmModel?.shape ||
        Boolean(fdmModel.notice?.includes("DomainMeta is missing")));
    const openSessionMeshSizing = () => {
      kernel.selection.set(
        {
          kind: "mesh.root",
          label: "Mesh",
          nodeId: "model:mesh",
          objectId: null,
          ref: null,
        },
        "inspector",
      );
    };

    return {
      id: "object.mesh",
      header: {
        breadcrumbs: [
          {
            id: "objects",
            label: "Objects",
            selection: {
              kind: "objects.root",
              label: "Objects",
              nodeId: "model:objects",
              objectId: null,
              ref: null,
            },
          },
          {
            id: "object",
            label: objectName,
            selection: {
              kind: "object.root",
              label: objectName,
              nodeId: `model:object:${objectId}`,
              objectId,
              ref: null,
            },
          },
          { id: "mesh", label: "Mesh" },
        ],
        canFitView: true,
        primaryHeaderAction: fdmMode
          ? {
              icon: Grid3x3,
              label: fdmGridMissing
                ? hasAuthoredFdmCell
                  ? "Build FDM Grid"
                  : "Configure Cell Size"
                : "Re-voxelize / Build Grid",
              onRun: async () => {
                if (fdmGridMissing && !hasAuthoredFdmCell) {
                  openSessionMeshSizing();
                  return;
                }
                await kernel.commands.execute("grid.build-fdm", commandContext);
              },
            }
          : {
              icon: Grid3x3,
              label: "Build Object Mesh",
              onRun: async (ctx) => {
                await runMeshBuildCommand(
                  "mesh.build-selected",
                  ctx.draft,
                  ctx.baseline,
                );
              },
            },
        extraMenuActions: fdmMode
          ? undefined
          : [
              {
                icon: Layers,
                id: "build-shared-domain",
                label: "Build Shared-Domain Mesh",
                onSelect: async (ctx) => {
                  await runMeshBuildCommand(
                    "mesh.build-shared-domain",
                    ctx.draft,
                    ctx.baseline,
                  );
                },
              },
            ],
      },
      identity: {
        domain: "mesh",
        entityId: objectId ? `object:${objectId}:mesh` : undefined,
        icon: Box,
        kindLabel: fdmMode ? "FDM voxel participation" : "Object FEM mesh policy",
        statePill: (d) =>
          fdmMode
            ? { label: "Structured mask", tone: "info" }
            : d.policyMode === "custom"
              ? { label: "Custom policy", tone: "ok" }
              : { label: "Inherited", tone: "neutral" },
        title: () => `${objectName} Mesh`,
      },
      facts: (d) => {
        if (fdmMode) {
          return [
            { id: "mode", label: "Lane", value: "FDM Voxel Mask" },
            {
              id: "shape",
              label: "Grid shape",
              value: fdmModel?.shape ? fdmModel.shape.join(" × ") : null,
            },
            {
              id: "active-cells",
              label: "Active cells",
              value:
                fdmModel?.activeCellCount != null
                  ? fdmModel.activeCellCount.toLocaleString("en-US")
                  : null,
            },
            { id: "source", label: "Geometry", value: geometryKind },
          ];
        }
        return [
          {
            id: "mode",
            label: "Policy mode",
            value: d.policyMode === "custom" ? "Custom override" : "Inherit domain",
          },
          { id: "source", label: "Geometry source", value: geometryKind },
          {
            id: "hmax",
            label: "Max element h_max",
            value: formatLengthSmartLocal(asNumber(d.maximumElementSize)),
          },
          {
            id: "elements",
            label: "Realized elements",
            value:
              realizedElements !== null && realizedElements !== undefined
                ? realizedElements.toLocaleString("en-US")
                : null,
          },
        ];
      },
      notices: (d) => {
        const notices: InspectorNotice<ObjectMeshSpecDraft>[] = [];
        if (statusFeedback) {
          notices.push({
            id: "restore-feedback",
            text: statusFeedback.text,
            tone: statusFeedback.tone,
          });
        }
        if (fdmMode && fdmGridMissing) {
          notices.push({
            id: "fdm-notice",
            quickFix: {
              label: "Configure Cell Size",
              onApply: openSessionMeshSizing,
            },
            text: authoredCellLabel
              ? `Session cell size (${authoredCellLabel}) is configured, but the structured FDM grid has not been built yet. Build the grid to materialize voxel cells and enable grid wireframe.`
              : "Cell size (Δx, Δy, Δz) is configured at the session Mesh level. Open Discretization & Mesh to set cell size and build the FDM grid.",
            title: "FDM grid not built yet",
            tone: "warn",
          });
        } else if (fdmMode && fdmModel?.notice) {
          notices.push({
            id: "fdm-notice",
            text: sanitizeMeshDisplayText(fdmModel.notice),
            tone: fdmModel.status === "error" ? "err" : "warn",
          });
        }
        if (!fdmMode && d.policyMode === "custom") {
          const capErr = validateObjectMeshTopologyCapabilities(
            { ...d, present: true },
            topologyCapabilities,
          );
          if (capErr) {
            notices.push({
              id: "cap-err",
              text: sanitizeMeshDisplayText(capErr),
              title: "Topology capability gate",
              tone: "err",
            });
          }
          if (d.meshStrategy === "swept_prism" && d.throughThicknessElements === "1") {
            notices.push({
              id: "single-prism-layer",
              text: "One exact prism layer requires layer-convergence evidence (1/2/3 layers) before scientific qualification.",
              tone: "warn",
            });
          }
        }
        return notices;
      },
      modeTabs: fdmMode
        ? undefined
        : [
            { id: "policy", label: "Policy & Strategy" },
            { id: "refinement", label: "Refinement & Fields" },
            { commitModeOverride: "readOnly", id: "quality", label: "Quality" },
            { commitModeOverride: "readOnly", id: "history", label: "History" },
          ],
      sections: fdmMode
        ? [
            {
              defaultOpen: true,
              footer: () => (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    type="button"
                    variant={fdmGridMissing && !hasAuthoredFdmCell ? "primary" : "secondary"}
                    onClick={openSessionMeshSizing}
                  >
                    Configure Cell Size (Mesh)
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant={fdmGridMissing && hasAuthoredFdmCell ? "primary" : "secondary"}
                    onClick={() => {
                      if (fdmGridMissing && !hasAuthoredFdmCell) {
                        openSessionMeshSizing();
                        return;
                      }
                      void kernel.commands.execute("grid.build-fdm", commandContext);
                    }}
                  >
                    {fdmGridMissing ? "Build FDM Grid" : "Re-voxelize / Build Grid"}
                  </Button>
                </div>
              ),
              icon: Grid3x3,
              id: "fdm-participation",
              rows: [
                {
                  format: () => authoredCellLabel ?? "Not configured — set in Mesh",
                  hint: "Structured FDM cell spacing (Δx, Δy, Δz) is shared across the session.",
                  label: "Session cell size",
                  mono: Boolean(authoredCellLabel),
                  type: "readonly",
                },
                {
                  format: () => "Execution-plan owned structured grid (read-only)",
                  label: "Mesh policy",
                  type: "readonly",
                },
                {
                  format: () => sanitizeMeshDisplayText(fdmModel?.status, "ready"),
                  label: "Grid status",
                  type: "readonly",
                },
                {
                  format: () =>
                    fdmModel?.origin
                      ? `${fdmModel.origin.join(", ")} m`
                      : "Not materialized",
                  label: "Origin",
                  mono: true,
                  type: "readonly",
                },
                {
                  format: () =>
                    fdmModel?.spacing
                      ? `${fdmModel.spacing.join(", ")} m`
                      : "Not materialized",
                  label: "Spacing",
                  mono: true,
                  type: "readonly",
                },
                {
                  format: () =>
                    fdmModel?.shape ? fdmModel.shape.join(" × ") : "Not materialized",
                  label: "Grid shape",
                  mono: true,
                  type: "readonly",
                },
                {
                  format: () =>
                    fdmModel?.totalCells != null
                      ? fdmModel.totalCells.toLocaleString("en-US")
                      : "Not materialized",
                  label: "Total cells",
                  mono: true,
                  type: "readonly",
                },
                {
                  format: () => {
                    if (!fdmModel) return "Not materialized";
                    if (fdmModel.participation === "canonical-mask") {
                      return `${(fdmModel.activeCellCount ?? 0).toLocaleString("en-US")} active · ${(fdmModel.inactiveCellCount ?? 0).toLocaleString("en-US")} outside support`;
                    }
                    if (fdmModel.participation === "descriptor-only") {
                      return "Canonical mask descriptor available; binary mask pending";
                    }
                    if (fdmModel.participation === "legacy-ambiguous") {
                      return "Legacy mask is ambiguous; classification withheld";
                    }
                    return "Not materialized";
                  },
                  label: "Cell participation",
                  type: "readonly",
                },
                {
                  format: () =>
                    fdmModel && fdmModel.metadata.length > 0
                      ? fdmModel.metadata
                          .map((entry) => `${entry.regionId} (${entry.numericId})`)
                          .join(", ")
                      : "None for selected object",
                  label: "Region metadata",
                  type: "readonly",
                },
                {
                  format: () => fdmModel?.gridFingerprint ?? "Not materialized",
                  label: "Grid fingerprint",
                  mono: true,
                  type: "readonly",
                },
              ],
              title: "Structured grid participation",
            },
          ]
        : [
            // TAB 1: Policy & Strategy
            {
              defaultOpen: true,
              footer: (ctx) => (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      void runMeshBuildCommand(
                        "mesh.build-selected",
                        ctx.draft,
                        ctx.baseline,
                      );
                    }}
                  >
                    {JSON.stringify(ctx.draft) !== JSON.stringify(ctx.baseline)
                      ? "Apply & Build Object Mesh"
                      : "Build Object Mesh"}
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      void runMeshBuildCommand(
                        "mesh.build-shared-domain",
                        ctx.draft,
                        ctx.baseline,
                      );
                    }}
                  >
                    Build Shared-Domain Mesh
                  </Button>
                </div>
              ),
              icon: SlidersHorizontal,
              id: "policy-mode",
              modeTabId: "policy",
              rows: [
                {
                  key: "policyMode",
                  label: "Policy ownership",
                  options: [
                    { label: "Inherit shared domain", value: "inherit" },
                    { label: "Custom object policy", value: "custom" },
                  ],
                  structural: true,
                  type: "segmented",
                },
                {
                  format: () =>
                    `${formatLengthSmartLocal(asNumber(recordField(effectiveTarget, "minimum_element_size"))) ?? "unset"} → ${formatLengthSmartLocal(asNumber(recordField(effectiveTarget, "maximum_element_size"))) ?? "unset"} (${sanitizeMeshDisplayText(recordField(effectiveTarget, "source"), "domain")})`,
                  label: "Effective target",
                  mono: true,
                  type: "readonly",
                },
                {
                  disabledReason: customDisabled,
                  key: "calibrateFor",
                  label: "Calibrate for",
                  options: MESH_SIZE_CALIBRATIONS,
                  type: "select",
                },
                {
                  disabledReason: customDisabled,
                  key: "sizePreset",
                  label: "Size preset",
                  options: MESH_SIZE_PRESETS,
                  type: "select",
                },
                {
                  disabledReason: customDisabled,
                  key: "sizeFactor",
                  label: "Preset size factor",
                  mono: true,
                  placeholder: "1.0",
                  type: "text",
                },
              ],
              title: "Policy ownership & presets",
            },
            {
              defaultOpen: true,
              icon: Ruler,
              id: "element-size-semantics",
              modeTabId: "policy",
              rows: [
                {
                  disabledReason: customDisabled,
                  key: "maximumElementSize",
                  label: "Maximum element size (m)",
                  mono: true,
                  placeholder: "e.g. 4e-9",
                  symbol: (
                    <>
                      h<sub>max</sub>
                    </>
                  ),
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "minimumElementSize",
                  label: "Minimum element size (m)",
                  mono: true,
                  placeholder: "e.g. 2e-9",
                  symbol: (
                    <>
                      h<sub>min</sub>
                    </>
                  ),
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "maximumElementGrowthRate",
                  label: "Maximum growth rate",
                  mono: true,
                  placeholder: "1.3",
                  symbol: <>g</>,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "curvatureFactor",
                  label: "Curvature factor",
                  mono: true,
                  placeholder: "0.35",
                  symbol: <>&kappa;</>,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "sizeFromCurvature",
                  label: "Size from curvature",
                  mono: true,
                  placeholder: "0",
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "narrowRegions",
                  label: "Narrow regions",
                  mono: true,
                  placeholder: "0",
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "narrowRegionResolution",
                  label: "Narrow region resolution",
                  mono: true,
                  placeholder: "2",
                  type: "text",
                },
                {
                  disabledReason: (d) =>
                    d.policyMode !== "custom"
                      ? "Switch to Custom object policy to edit FEM order."
                      : d.meshStrategy === "swept_prism"
                        ? "Exact layered prism fixes polynomial order to P1."
                        : null,
                  key: "order",
                  label: "FEM polynomial order",
                  options: [
                    { label: "Inherited", value: "" },
                    { label: "P1 Linear (1)", value: "1" },
                    { label: "P2 Quadratic (2)", value: "2" },
                  ],
                  type: "select",
                },
              ],
              title: "Element size parameters",
            },
            {
              defaultOpen: true,
              icon: Layers,
              id: "sweep-strategy",
              modeTabId: "policy",
              rows: [
                {
                  disabledReason: customDisabled,
                  key: "meshStrategy",
                  label: "Mesh strategy",
                  options: [
                    { label: "Inherited", value: "" },
                    { label: "Free tetrahedral", value: "free_tetrahedral" },
                    {
                      disabledReason: topologyCapabilities.layeredPrism.enabled
                        ? undefined
                        : sanitizeMeshDisplayText(
                            topologyCapabilities.layeredPrism.reason,
                            "Layered prism capability is not enabled",
                          ),
                      label: "Layered prism (exact)",
                      value: "swept_prism",
                    },
                  ],
                  structural: true,
                  type: "select",
                },
                {
                  disabledReason: (d) =>
                    d.policyMode !== "custom" || d.meshStrategy !== "swept_prism"
                      ? "Select Custom object policy and Layered prism (exact) to choose layer count."
                      : !topologyCapabilities.layeredPrism.enabled
                        ? sanitizeMeshDisplayText(
                            topologyCapabilities.layeredPrism.reason,
                          )
                        : null,
                  key: "throughThicknessElements",
                  label: "Through-thickness elements",
                  options: [
                    { label: "1 layer (2 node planes)", value: "1" },
                    { label: "2 layers (3 node planes)", value: "2" },
                    { label: "3 layers (4 node planes)", value: "3" },
                  ],
                  type: "select",
                },
                {
                  format: (d) => {
                    const planes = nodePlaneCount(d.throughThicknessElements);
                    return `${d.topology || "inherited"} · node planes: ${planes ?? "unset"} · transition: ${d.transitionPolicy || "none"}`;
                  },
                  label: "Resolved sweep contract",
                  mono: true,
                  type: "readonly",
                },
              ],
              title: "Thin-film sweep strategy",
            },
            {
              defaultOpen: false,
              icon: Settings2,
              id: "backend-parameters",
              modeTabId: "policy",
              rows: [
                {
                  disabledReason: customDisabled,
                  key: "algorithm2d",
                  label: "Gmsh 2D algorithm",
                  mono: true,
                  placeholder: "6",
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "algorithm3d",
                  label: "Gmsh 3D algorithm",
                  mono: true,
                  placeholder: "1",
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "smoothingSteps",
                  label: "Smoothing steps",
                  mono: true,
                  placeholder: "1",
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "optimize",
                  label: "Post-mesh optimizer",
                  options: [
                    { label: "Inherited", value: "" },
                    { label: "Netgen", value: "Netgen" },
                    { label: "High order", value: "HighOrder" },
                    { label: "Relocate 3D", value: "Relocate3D" },
                  ],
                  type: "select",
                },
                {
                  disabledReason: customDisabled,
                  key: "optimizeIterations",
                  label: "Optimizer iterations",
                  mono: true,
                  placeholder: "1",
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "computeQuality",
                  label: "Compute quality",
                  options: [
                    { label: "Inherited", value: "" },
                    { label: "Enabled", value: "true" },
                    { label: "Disabled", value: "false" },
                  ],
                  type: "select",
                },
                {
                  disabledReason: customDisabled,
                  key: "perElementQuality",
                  label: "Per-element quality",
                  options: [
                    { label: "Inherited", value: "" },
                    { label: "Enabled", value: "true" },
                    { label: "Disabled", value: "false" },
                  ],
                  type: "select",
                },
                {
                  disabledReason: customDisabled,
                  key: "boundaryLayerCount",
                  label: "Boundary-layer count",
                  mono: true,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "boundaryLayerThickness",
                  label: "Boundary-layer thickness (m)",
                  mono: true,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "boundaryLayerStretching",
                  label: "Boundary-layer stretching",
                  mono: true,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "boundaryLayerTargetSurfaceTags",
                  label: "Boundary-layer surface tags",
                  mono: true,
                  placeholder: "e.g. 1, 2",
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "boundaryLayerTargetCurveTags",
                  label: "Boundary-layer curve tags",
                  mono: true,
                  placeholder: "e.g. 3, 4",
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "boundaryLayerTargetSurfaceSelectors",
                  label: "Boundary-layer surface selectors (JSON)",
                  multiline: true,
                  placeholder: "[]",
                  type: "expression",
                  wide: true,
                },
                {
                  disabledReason: customDisabled,
                  key: "boundaryLayerTargetCurveSelectors",
                  label: "Boundary-layer curve selectors (JSON)",
                  multiline: true,
                  placeholder: "[]",
                  type: "expression",
                  wide: true,
                },
                {
                  format: () =>
                    `${realizedObjectSizeFields.length} (${sizeFieldKinds.length > 0 ? sizeFieldKinds.join(", ") : "none"})`,
                  label: "Realized object size fields",
                  type: "readonly",
                },
                {
                  disabledReason: customDisabled,
                  key: "configText",
                  label: "Advanced policy JSON",
                  multiline: true,
                  type: "expression",
                  validate: (val) => objectMeshPolicyJsonError(val),
                  wide: true,
                },
              ],
              title: "Backend Gmsh & boundary-layer parameters",
            },

            // TAB 2: Refinement & Size Fields
            {
              defaultOpen: true,
              icon: Ruler,
              id: "interface-transition",
              modeTabId: "refinement",
              rows: [
                {
                  disabledReason: customDisabled,
                  key: "interfaceMaximumElementSize",
                  label: "Interface max element size (m)",
                  mono: true,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "interfaceThickness",
                  label: "Interface thickness (m)",
                  mono: true,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  hint: "Positive length in meters or airbox_boundary",
                  key: "transitionDistance",
                  label: "Transition distance",
                  mono: true,
                  placeholder: "airbox_boundary",
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "transitionGrowth",
                  label: "Transition growth",
                  mono: true,
                  type: "text",
                },
              ],
              title: "Interface & transition refinement",
            },
            {
              defaultOpen: true,
              icon: Activity,
              id: "core-relaxation",
              modeTabId: "refinement",
              rows: [
                {
                  disabledReason: customDisabled,
                  key: "coreRelaxationEnabled",
                  label: "Use object core relaxation",
                  structural: true,
                  type: "switch",
                },
                {
                  key: "coreRelaxationGeometryName",
                  label: "Geometry name",
                  showWhen: (d) => d.coreRelaxationEnabled,
                  type: "text",
                },
                {
                  key: "coreRelaxationMaximumElementSize",
                  label: "Core max element size (m)",
                  mono: true,
                  showWhen: (d) => d.coreRelaxationEnabled,
                  type: "text",
                },
                {
                  key: "coreRelaxationSurfaceMaximumElementSize",
                  label: "Surface max element size (m)",
                  mono: true,
                  showWhen: (d) => d.coreRelaxationEnabled,
                  type: "text",
                },
                {
                  key: "coreRelaxationSurfaceDistance",
                  label: "Surface distance (m)",
                  mono: true,
                  showWhen: (d) => d.coreRelaxationEnabled,
                  type: "text",
                },
                {
                  key: "coreRelaxationEdgeMaximumElementSize",
                  label: "Edge max element size (m)",
                  mono: true,
                  showWhen: (d) => d.coreRelaxationEnabled,
                  type: "text",
                },
                {
                  key: "coreRelaxationEdgeDistance",
                  label: "Edge distance (m)",
                  mono: true,
                  showWhen: (d) => d.coreRelaxationEnabled,
                  type: "text",
                },
                {
                  key: "coreRelaxationSamplingSurface",
                  label: "Surface sampling",
                  mono: true,
                  showWhen: (d) => d.coreRelaxationEnabled,
                  type: "text",
                },
                {
                  key: "coreRelaxationSamplingEdge",
                  label: "Edge sampling",
                  mono: true,
                  showWhen: (d) => d.coreRelaxationEnabled,
                  type: "text",
                },
              ],
              title: "Object Core Relaxation",
            },
            {
              defaultOpen: false,
              icon: Box,
              id: "manual-box-field",
              modeTabId: "refinement",
              rows: [
                {
                  disabledReason: customDisabled,
                  key: "manualBoxSizeFieldEnabled",
                  label: "Use Manual Box size field",
                  structural: true,
                  type: "switch",
                },
                {
                  key: "manualBoxSizeFieldVIn",
                  label: "Box VIn (m)",
                  mono: true,
                  showWhen: (d) => d.manualBoxSizeFieldEnabled,
                  type: "text",
                },
                {
                  key: "manualBoxSizeFieldVOut",
                  label: "Box VOut (m)",
                  mono: true,
                  showWhen: (d) => d.manualBoxSizeFieldEnabled,
                  type: "text",
                },
                {
                  key: "manualBoxSizeFieldXMin",
                  label: "Box X min (m)",
                  mono: true,
                  showWhen: (d) => d.manualBoxSizeFieldEnabled,
                  type: "text",
                },
                {
                  key: "manualBoxSizeFieldXMax",
                  label: "Box X max (m)",
                  mono: true,
                  showWhen: (d) => d.manualBoxSizeFieldEnabled,
                  type: "text",
                },
                {
                  key: "manualBoxSizeFieldYMin",
                  label: "Box Y min (m)",
                  mono: true,
                  showWhen: (d) => d.manualBoxSizeFieldEnabled,
                  type: "text",
                },
                {
                  key: "manualBoxSizeFieldYMax",
                  label: "Box Y max (m)",
                  mono: true,
                  showWhen: (d) => d.manualBoxSizeFieldEnabled,
                  type: "text",
                },
                {
                  key: "manualBoxSizeFieldZMin",
                  label: "Box Z min (m)",
                  mono: true,
                  showWhen: (d) => d.manualBoxSizeFieldEnabled,
                  type: "text",
                },
                {
                  key: "manualBoxSizeFieldZMax",
                  label: "Box Z max (m)",
                  mono: true,
                  showWhen: (d) => d.manualBoxSizeFieldEnabled,
                  type: "text",
                },
              ],
              title: "Manual Box Size Field",
            },
            {
              defaultOpen: false,
              icon: SlidersHorizontal,
              id: "edge-corner-refinement",
              modeTabId: "refinement",
              rows: [
                {
                  disabledReason: customDisabled,
                  key: "edgeMaximumElementSize",
                  label: "Edge max element size (m)",
                  mono: true,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "edgeThickness",
                  label: "Edge thickness (m)",
                  mono: true,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  hint: "Positive meters or airbox_boundary",
                  key: "edgeTransitionDistance",
                  label: "Edge transition distance",
                  mono: true,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "cornerMaximumElementSize",
                  label: "Corner max element size (m)",
                  mono: true,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  key: "cornerExtent",
                  label: "Corner extent (m)",
                  mono: true,
                  type: "text",
                },
                {
                  disabledReason: customDisabled,
                  hint: "Positive meters or airbox_boundary",
                  key: "cornerTransitionDistance",
                  label: "Corner transition distance",
                  mono: true,
                  type: "text",
                },
              ],
              title: "Edge & Corner Refinement",
            },

            // TAB 3: Quality
            {
              defaultOpen: true,
              icon: Gauge,
              id: "object-quality-tab",
              modeTabId: "quality",
              rows: [
                {
                  format: () => formatCountClean(topologyRes.data?.nodeCount),
                  label: "Nodes",
                  mono: true,
                  type: "readonly",
                },
                {
                  format: () => formatCountClean(topologyRes.data?.elementCount),
                  label: "Elements",
                  mono: true,
                  type: "readonly",
                },
                {
                  format: () => formatCountClean(topologyRes.data?.boundaryFaceCount),
                  label: "Boundary faces",
                  mono: true,
                  type: "readonly",
                },
                {
                  format: () =>
                    asNumber(asRecord(qualityRes.data)?.revision) !== null
                      ? String(asNumber(asRecord(qualityRes.data)?.revision))
                      : "Not published",
                  label: "Quality revision",
                  mono: true,
                  type: "readonly",
                },
                {
                  render: () => (
                    <MeshQualityStatisticsSpecView
                      statistics={qualityStatistics}
                      onHoverSizeDistributionBin={hoverSizeDistributionBin}
                    />
                  ),
                  type: "custom",
                  wide: true,
                },
              ],
              title: "Object topology & quality distributions",
            },

            // TAB 4: History
            {
              defaultOpen: true,
              footer: (ctx) => (
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    ctx.selectNode({
                      kind: "mesh.builds",
                      label: "Mesh Build Pipeline",
                      nodeId: "model:mesh:builds",
                      objectId: null,
                      ref: null,
                    })
                  }
                >
                  View Mesh Pipeline
                </Button>
              ),
              icon: History,
              id: "object-history-tab",
              modeTabId: "history",
              rows: [
                {
                  render: (ctx) => (
                    <MeshBuildHistorySpecView
                      entries={buildHistoryEntries}
                      onRestore={(entry: MeshBuildHistoryEntry) => {
                        const objectSnapshots = asRecord(
                          entry.canonicalPolicySnapshot?.objects,
                        );
                        if (
                          !objectSnapshots ||
                          !Object.hasOwn(objectSnapshots, objectId)
                        ) {
                          setStatusFeedback({
                            text: `Build ${entry.id} contains no mesh snapshot for ${objectId}.`,
                            tone: "err",
                          });
                          return;
                        }
                        const snapshotValue = objectSnapshots[objectId];
                        const objectSnapshot =
                          snapshotValue === null ? null : asRecord(snapshotValue);
                        const restored = toSpecDraft(
                          draftFromObjectMeshPolicyResource(
                            {
                              ...resource,
                              config: objectSnapshot as JsonObject | null,
                            },
                            { effectiveTarget },
                          ),
                        );
                        ctx.patchDraft(restored);
                        setStatusFeedback({
                          text: `Build ${entry.id} restored to object draft. Click Apply to persist.`,
                          tone: "info",
                        });
                      }}
                    />
                  ),
                  type: "custom",
                  wide: true,
                },
              ],
              title: "Object mesh build history",
            },
          ],
      commitBar: fdmMode
        ? {
            mode: "readOnly",
            statusMessage: () =>
              "FDM voxel mask derives automatically from object geometry",
          }
        : {
            cleanMessage: (d) =>
              d.policyMode === "inherit"
                ? "Inheriting shared-domain FEM sizing"
                : "Custom object mesh policy saved",
            mode: "staged",
            onApply: persistObjectPolicy,
          },
    };
  }, [
    buildHistoryEntries,
    commandContext,
    effectiveTarget,
    fdmMode,
    fdmModel,
    geometryKind,
    hoverSizeDistributionBin,
    kernel.commands,
    kernel.selection,
    objectId,
    objectName,
    persistObjectPolicy,
    qualityRes.data,
    qualityStatistics,
    realizedObjectSizeFields.length,
    resource,
    runMeshBuildCommand,
    scene.data,
    setStatusFeedback,
    sizeFieldKinds,
    statusFeedback,
    topologyCapabilities,
    topologyRes.data,
  ]);

  return (
    <SpecInspectorHost
      baseline={baseline}
      seedStagedOverrides={restoredOverrides}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleAfterFieldChange}
    />
  );
}
