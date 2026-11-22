"use client";

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Box,
  Compass,
  FolderKanban,
  Globe,
  Layers,
  Link2,
  Magnet,
  Maximize2,
  Plus,
  Radio,
  Shield,
  Sliders,
  Trash2,
  Waves,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import {
  MODEL_COUPLINGS_PATH,
  MODEL_FIELD_DRIVES_PATH,
  MODEL_FROZEN_SPINS_PATH,
  MODEL_MASK_FIELD_DRIVES_PATH,
  MODEL_PHYSICS_GRAPH_PATH,
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
  MODEL_UNIVERSE_FIT_PATH,
  MODEL_UNIVERSE_PATH,
} from "@/kernel/api/apiPaths";
import type {
  AuthoringTransactionRequest,
  JsonObject,
  MaskFieldDriveResource,
  RegionalFieldDriveResource,
} from "@/kernel/api/apiTypes";

type SceneCoupling = Extract<AuthoringTransactionRequest, { kind: "create_coupling" }>["coupling"];
type SceneCouplingPatch = Extract<AuthoringTransactionRequest, { kind: "patch_coupling" }>["patch"];
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { MaterialLibraryDialog } from "@/kernel/layout/MaterialLibraryDialog";
import { useKernel } from "@/kernel/KernelContext";
import { useFieldDrivesResource } from "@/kernel/resources/fieldDriveResources";
import { useFrozenSpinsCollectionResource } from "@/kernel/resources/frozenSpinsResources";
import {
  MESH_SUMMARY_RESOURCE_KEY,
  publishCommittedSceneResource,
  useMeshSummaryResource,
  useModelCouplingsResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useMaskFieldDrivesResource } from "@/kernel/resources/maskAntennaResources";
import { usePhysicsGraphResource } from "@/kernel/resources/physicsGraphResources";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { useModelReadinessResource } from "@/kernel/resources/studyRuntimeResources";
import { useActiveLaneCapabilities } from "@/kernel/resources/useActiveLaneCapabilities";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/AlertDialog";
import { Badge } from "@/shared/ui/Badge";
import { Button } from "@/shared/ui/Button";
import { Switch } from "@/shared/ui/Switch";

import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorFact, InspectorNotice, InspectorSpec } from "../../template";
import {
  resolveAirboxInspectorAuthoringLane,
  resolveAirboxInspectorLane,
  useAirboxInspectorRuntimeStatus,
} from "../airbox/airboxInspectorRuntimeStatus";
import { navigateToStudyRoot } from "../airbox/airboxNavigation";
import {
  buildBuilderPrimitiveSelection,
  buildObjectSelection,
  buildRootSelection,
  fallbackRevision,
  formatSpanAuto,
  InspectorShortcutCards,
  type SceneObjectItem as SceneObject,
  SpecInspectorHost,
  type InspectorShortcutCardItem,
} from "./SpecInspectorHost";

function buildModelScopeMutationContext(
  kernel: ReturnType<typeof useKernel>,
  sceneData: unknown,
  explicitScopeKey?: string | null,
) {
  const effectiveScopeKey =
    explicitScopeKey ?? kernel.commands?.getSessionScopeKey?.() ?? null;
  const historyGeneration = kernel.authoringHistory?.getGeneration?.();
  const baseCtx = createCommandContext("inspector", kernel, {
    resourceData: sceneData ? { [MODEL_SCENE_PATH]: sceneData } : undefined,
    ...(effectiveScopeKey ? { sessionScopeKey: effectiveScopeKey } : {}),
    isCurrentSessionScope: () => {
      const activeScope = kernel.commands?.getSessionScopeKey?.();
      if (effectiveScopeKey && activeScope && activeScope !== effectiveScopeKey) {
        return false;
      }
      return (
        historyGeneration === undefined ||
        kernel.authoringHistory?.getGeneration?.() === historyGeneration
      );
    },
  });
  return {
    context:
      typeof kernel.selection?.get === "function"
        ? baseCtx
        : { ...baseCtx, selection: undefined },
    reqOptions: effectiveScopeKey ? { sessionScopeKey: effectiveScopeKey } : undefined,
  };
}

function extractFieldDriveItems(resourceData: unknown): Record<string, unknown>[] {
  if (!resourceData || typeof resourceData !== "object") return [];
  const rec = resourceData as { drives?: unknown[]; items?: unknown[] };
  const arr = Array.isArray(rec.drives)
    ? rec.drives
    : Array.isArray(rec.items)
      ? rec.items
      : [];
  return arr as Record<string, unknown>[];
}

/* ── Shared Helpers for Model Roots ── */

function isAirboxSceneObject(obj: SceneObject): boolean {
  const role = obj.role?.trim().toLowerCase() ?? "";
  const id = obj.id.trim().toLowerCase();
  return role === "air" || role === "airbox" || id === "airbox" || id === "__airbox__";
}

function resolveObjectBoundsMeters(
  obj: SceneObject,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const geom = (obj.geometry ?? null) as Record<string, unknown> | null;
  if (!geom) return null;
  const bMin = geom.bounds_min;
  const bMax = geom.bounds_max;
  if (
    Array.isArray(bMin) &&
    Array.isArray(bMax) &&
    bMin.length >= 3 &&
    bMax.length >= 3 &&
    bMin.every((v) => typeof v === "number" && Number.isFinite(v)) &&
    bMax.every((v) => typeof v === "number" && Number.isFinite(v))
  ) {
    return {
      min: [bMin[0] as number, bMin[1] as number, bMin[2] as number],
      max: [bMax[0] as number, bMax[1] as number, bMax[2] as number],
    };
  }
  const params = (geom.geometry_params ?? null) as Record<string, unknown> | null;
  const tx = (obj.transform ?? null) as Record<string, unknown> | null;
  const tr = Array.isArray(tx?.translation) && tx.translation.length >= 3
    ? [
        Number(tx.translation[0]) || 0,
        Number(tx.translation[1]) || 0,
        Number(tx.translation[2]) || 0,
      ]
    : [0, 0, 0];
  let span: [number, number, number] | null = null;
  if (Array.isArray(params?.size) && params.size.length >= 3) {
    span = [
      Math.abs(Number(params.size[0]) || 0),
      Math.abs(Number(params.size[1]) || 0),
      Math.abs(Number(params.size[2]) || 0),
    ];
  } else if (typeof params?.radius === "number") {
    const r = Math.abs(params.radius);
    const h = typeof params?.height === "number" ? Math.abs(params.height) : 2 * r;
    span = [2 * r, 2 * r, h];
  } else if (
    typeof params?.length === "number" &&
    typeof params?.width === "number" &&
    typeof params?.height === "number"
  ) {
    const archH = typeof params?.arch_height === "number" ? Math.abs(params.arch_height) : 0;
    span = [Math.abs(params.length), Math.abs(params.width), Math.abs(params.height) + archH];
  }
  if (!span || span.some((v) => v <= 0)) return null;
  return {
    min: [tr[0]! - span[0] / 2, tr[1]! - span[1] / 2, tr[2]! - span[2] / 2],
    max: [tr[0]! + span[0] / 2, tr[1]! + span[1] / 2, tr[2]! + span[2] / 2],
  };
}

function computeSceneObjectsAabb(objects: readonly SceneObject[]): {
  min: [number, number, number];
  max: [number, number, number];
  span: [number, number, number];
  center: [number, number, number];
} | null {
  const authored = objects.filter((o) => !isAirboxSceneObject(o));
  if (authored.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const obj of authored) {
    const bounds = resolveObjectBoundsMeters(obj);
    if (!bounds) continue;
    minX = Math.min(minX, bounds.min[0]);
    minY = Math.min(minY, bounds.min[1]);
    minZ = Math.min(minZ, bounds.min[2]);
    maxX = Math.max(maxX, bounds.max[0]);
    maxY = Math.max(maxY, bounds.max[1]);
    maxZ = Math.max(maxZ, bounds.max[2]);
    count += 1;
  }
  if (count === 0) return null;
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    span: [maxX - minX, maxY - minY, maxZ - minZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
  };
}

function isUnscopedFrozenSelector(selector: unknown): boolean {
  if (!selector || typeof selector !== "object") return true;
  const rec = selector as Record<string, unknown>;
  if (rec.kind === "in_object" || rec.kind === "in_region") return false;
  if (
    (rec.kind === "and" || rec.kind === "or" || rec.kind === "xor") &&
    Array.isArray(rec.expressions) &&
    rec.expressions.length > 0
  ) {
    return rec.expressions.some((child) => isUnscopedFrozenSelector(child));
  }
  return true;
}

/* ── 1. SessionRootInspectorPanel (`session.root`) ── */

interface SessionRootDraft {
  title: string;
  notes: string;
  objectCount: number;
  regionCount: number;
  couplingCount: number;
  materialCount: number;
  laneLabel: string | null;
  blockingCount: number;
  warningCount: number;
}

export function SessionRootInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const readiness = useModelReadinessResource({ enabled: true });
  const activeLane = useActiveLaneCapabilities();

  const objects = useMemo(
    () => (scene.data?.objects ?? []).filter((o) => !isAirboxSceneObject(o)),
    [scene.data?.objects],
  );
  const regionCount = useMemo(
    () => objects.reduce((acc, obj) => acc + (obj.regions?.length ?? 0), 0),
    [objects],
  );
  const couplingCount = scene.data?.couplings?.length ?? 0;
  const materialCount = scene.data?.materials?.length ?? 0;
  const studyRecord = (scene.data?.study ?? null) as Record<string, unknown> | null;
  const sceneMeta = (scene.data?.scene ?? null) as Record<string, unknown> | null;
  const rawSceneName = typeof sceneMeta?.name === "string" ? sceneMeta.name.trim() : "";
  const rawStudyName = typeof studyRecord?.name === "string" ? studyRecord.name.trim() : "";
  const studyName =
    rawSceneName && (rawSceneName !== "Scene" || !rawStudyName)
      ? rawSceneName
      : rawStudyName || rawSceneName || "Session Model";
  const studyDescription =
    typeof sceneMeta?.notes === "string"
      ? sceneMeta.notes
      : typeof studyRecord?.description === "string"
        ? studyRecord.description
        : "";
  const activeLaneKind =
    (activeLane as { lane?: string } | null)?.lane ??
    (activeLane?.source?.kind === "planner" ? activeLane.resolved?.discretization : null);
  const laneRaw =
    activeLaneKind === "fem" || activeLaneKind === "fdm"
      ? activeLaneKind
      : typeof studyRecord?.discretization === "string"
        ? studyRecord.discretization
        : null;
  const laneLabel =
    laneRaw === "fem" ? "FEM" : laneRaw === "fdm" ? "FDM" : null;

  const checks = useMemo(() => readiness.data?.checks ?? [], [readiness.data?.checks]);
  const blockingChecks = useMemo(
    () =>
      checks.filter((c) => {
        const s = String((c as Record<string, unknown>).status ?? "").toLowerCase();
        return s === "blocked" || s === "failed" || s === "error";
      }),
    [checks],
  );
  const warningChecks = useMemo(
    () =>
      checks.filter((c) => {
        const s = String((c as Record<string, unknown>).status ?? "").toLowerCase();
        return s === "warning" || s === "degraded";
      }),
    [checks],
  );

  const objectCount = objects.length;
  const blockingCount = blockingChecks.length;
  const warningCount = warningChecks.length;

  const baseline = useMemo<SessionRootDraft>(
    () => ({
      title: studyName,
      notes: studyDescription,
      objectCount,
      regionCount,
      couplingCount,
      materialCount,
      laneLabel,
      blockingCount,
      warningCount,
    }),
    [
      blockingCount,
      couplingCount,
      laneLabel,
      materialCount,
      objectCount,
      regionCount,
      studyDescription,
      studyName,
      warningCount,
    ],
  );

  const branchCards = useMemo<readonly InspectorShortcutCardItem[]>(
    () => [
      {
        id: "universe",
        title: "Universe",
        subtitle: "Outer computational domain & boundary policy",
        selection: buildRootSelection("universe.root", "model:universe", "Universe"),
      },
      {
        id: "objects",
        title: "Objects",
        subtitle: "Authored geometry primitives & magnetic bodies",
        badge: `${objects.length}`,
        selection: buildRootSelection("objects.root", "model:objects", "Objects"),
      },
      {
        id: "definitions",
        title: "Definitions",
        subtitle: "Session materials, planar monitors & constraints",
        badge: `${materialCount}`,
        selection: buildRootSelection("definitions.root", "model:definitions", "Definitions"),
      },
      {
        id: "global-physics",
        title: "Global Physics",
        subtitle: "Demagnetization, external field, thermal & PBC",
        selection: buildRootSelection("physics.scope.global", "model:physics:global", "Global Physics"),
      },
      {
        id: "couplings",
        title: "Couplings",
        subtitle: "Inter-object & interface exchange interactions",
        badge: `${couplingCount}`,
        selection: buildRootSelection("physics.couplings", "model:physics:couplings", "Couplings"),
      },
      {
        id: "mesh",
        title: "Mesh",
        subtitle: "Discretization policy, builds & quality gates",
        ...(laneLabel ? { badge: laneLabel, tone: "info" as const } : {}),
        selection: buildRootSelection("mesh.root", "model:mesh", "Mesh"),
      },
      {
        id: "study",
        title: "Study",
        subtitle: "Execution pipeline, solver stages & outputs",
        selection: buildRootSelection("study.root", "model:study", "Study"),
      },
    ],
    [couplingCount, laneLabel, materialCount, objects.length],
  );

  const spec = useMemo<InspectorSpec<SessionRootDraft>>(
    () => ({
      id: "model.session-root",
      header: {
        breadcrumbs: [{ id: "session", label: "Session Model" }],
        searchable: false,
      },
      identity: {
        domain: "definition",
        icon: FolderKanban,
        title: (draft) => draft.title || "Session Model",
        renameFieldKey: "title",
        kindLabel: "Session model root",
        entityId: "model:session",
        statePill: (draft) =>
          draft.blockingCount > 0
            ? { tone: "err", label: `${draft.blockingCount} blocking` }
            : draft.warningCount > 0
              ? { tone: "warn", label: `${draft.warningCount} warnings` }
              : { tone: "ok", label: "Ready" },
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "objects", label: "Objects", value: String(draft.objectCount) },
        { id: "regions", label: "Regions", value: String(draft.regionCount) },
        { id: "lane", label: "Discretization", value: draft.laneLabel, tone: "info" },
        {
          id: "readiness",
          label: "Readiness",
          value:
            draft.blockingCount > 0
              ? `${draft.blockingCount} blocked`
              : draft.warningCount > 0
                ? `${draft.warningCount} warn`
                : "Verified",
          tone: draft.blockingCount > 0 ? "err" : draft.warningCount > 0 ? "warn" : "ok",
        },
      ],
      notices: (): readonly InspectorNotice<SessionRootDraft>[] =>
        [...blockingChecks.slice(0, 3), ...warningChecks.slice(0, 2)].map((check, idx) => {
          const rec = check as Record<string, unknown>;
          const id = String(rec.id ?? rec.code ?? `check-${idx}`);
          const msg = String(rec.message ?? rec.summary ?? rec.label ?? "Review model readiness check.");
          const isBlocking = blockingChecks.includes(check);
          const category = String(rec.category ?? rec.domain ?? "").toLowerCase();
          const targetSelection: Omit<Selection, "moduleSource"> = category.includes("mesh")
            ? buildRootSelection("mesh.root", "model:mesh", "Mesh")
            : category.includes("study") || category.includes("stage")
              ? buildRootSelection("study.root", "model:study", "Study")
              : objects[0]
                ? buildObjectSelection(objects[0].id, "object.root", objects[0].name ?? objects[0].id)
                : buildRootSelection("objects.root", "model:objects", "Objects");
          return {
            id: `readiness-${id}`,
            tone: isBlocking ? "err" : "warn",
            title: String(rec.title ?? rec.code ?? (isBlocking ? "Readiness blocker" : "Readiness warning")),
            text: msg,
            quickFix: {
              label: "Inspect target",
              onApply: (ctx) => ctx.selectNode(targetSelection),
            },
          };
        }),
      sections: [
        {
          id: "session-identity",
          title: "Model identity",
          icon: FolderKanban,
          defaultOpen: true,
          summary: (draft) => draft.title,
          rows: [
            {
              key: "title",
              type: "text",
              label: "Model title",
              placeholder: "Enter descriptive model title",
              validate: (val) => (val.trim().length === 0 ? "Model title is required." : null),
            },
            {
              key: "notes",
              type: "textarea",
              label: "Authoring notes",
              rows: 3,
              placeholder: "Document simulation assumptions, geometry conventions, or citation notes",
            },
          ],
          footer: (ctx) => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={async () => {
                try {
                  const res = (await kernel.api.model.authoringScript()) as {
                    source?: string;
                    script?: string;
                  };
                  ctx.openCodePreview(
                    "Canonical ProblemIR script",
                    "python",
                    res.source ?? res.script ?? "",
                  );
                } catch {
                  ctx.openCodePreview(
                    "Session model snippet",
                    "python",
                    `# ${ctx.draft.title}\n# Objects: ${ctx.draft.objectCount}, Regions: ${ctx.draft.regionCount}`,
                  );
                }
              }}
            >
              View Python script
            </Button>
          ),
        },
        {
          id: "session-branches",
          title: "Model hierarchy",
          icon: Layers,
          defaultOpen: true,
          summary: (draft) => `${draft.objectCount} objects, ${draft.couplingCount} couplings`,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <InspectorShortcutCards items={branchCards} onSelect={ctx.selectNode} />
              ),
            },
          ],
        },
        {
          id: "session-quick-create",
          title: "Quick create",
          icon: Plus,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="grid grid-cols-2 gap-1.5" data-slot="session-quick-create">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      ctx.selectNode(buildBuilderPrimitiveSelection("box", "New Box"))
                    }
                  >
                    <Plus aria-hidden="true" size={13} />
                    <span>Add Object</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      void kernel.commands.execute(
                        "planar-monitor.create",
                        createCommandContext("inspector", kernel),
                      );
                    }}
                  >
                    <Plus aria-hidden="true" size={13} />
                    <span>Planar Monitor</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      ctx.selectNode(
                        buildRootSelection("physics.couplings", "model:physics:couplings", "Couplings"),
                      )
                    }
                  >
                    <Link2 aria-hidden="true" size={13} />
                    <span>Couplings</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      ctx.selectNode(
                        buildRootSelection(
                          "physics.field-drives",
                          "model:physics:field-drives",
                          "Field Drives",
                        ),
                      )
                    }
                  >
                    <Waves aria-hidden="true" size={13} />
                    <span>Field Drives</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        cleanMessage: () => "Session metadata matches canonical ProblemIR",
        onApply: async (draft) => {
          const { context } = buildModelScopeMutationContext(
            kernel,
            scene.data,
            scene.sessionScopeKey,
          );
          const reqOptions = scene.sessionScopeKey
            ? { sessionScopeKey: scene.sessionScopeKey }
            : undefined;
          const tx = await runAuthoringMutationWithHistory(
            context,
            `Edit session metadata ${draft.title.trim()}`,
            async ({ baseRevision: capturedRev }) => {
              const payload = {
                kind: "merge_patch" as const,
                base_revision: capturedRev ?? scene.data?.revision ?? 0,
                merge_patch: {
                  scene: {
                    name: draft.title.trim(),
                    notes: draft.notes,
                  },
                },
              };
              return reqOptions
                ? kernel.api.model.commitTransaction(payload, reqOptions)
                : kernel.api.model.commitTransaction(payload);
            },
          );
          publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
          const rev = fallbackRevision(tx.scene_revision);
          kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
          kernel.resources.invalidate(MODEL_STUDY_PATH, rev);
          kernel.resources.invalidate(MODEL_READINESS_PATH, rev);
          return true;
        },
      },
    }),
    [
      blockingChecks,
      branchCards,
      kernel,
      objects,
      scene.data,
      scene.sessionScopeKey,
      warningChecks,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 2. UniverseRootInspectorPanel (`universe.root`) ── */

interface UniverseRootDraft {
  name: string;
  universeSpanText: string | null;
  aabbMinText: string | null;
  aabbMaxText: string | null;
  aabbSpanText: string | null;
  aabbCenterText: string | null;
  objectCount: number;
  hasRealizedMesh: boolean;
  laneLabel: string | null;
}

export function UniverseRootInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const meshSummary = useMeshSummaryResource();
  const activeLane = useActiveLaneCapabilities();
  const runtimeStatus = useAirboxInspectorRuntimeStatus();

  const objects = useMemo(
    () => (scene.data?.objects ?? []).filter((o) => !isAirboxSceneObject(o)),
    [scene.data?.objects],
  );
  const aabb = useMemo(() => computeSceneObjectsAabb(objects), [objects]);
  const universeRec = (scene.data?.universe ?? null) as Record<string, unknown> | null;
  const universeName =
    typeof universeRec?.name === "string" && universeRec.name.trim()
      ? universeRec.name.trim()
      : "Universe";
  const universeSpanText = useMemo(() => {
    const sz = universeRec?.size;
    if (!Array.isArray(sz) || sz.length < 3) return null;
    return formatSpanAuto([Number(sz[0]) || 0, Number(sz[1]) || 0, Number(sz[2]) || 0]);
  }, [universeRec]);
  const hasRealizedMesh = Boolean(
    meshSummary.data ||
      objects.some((o) => Array.isArray(o.tags) && o.tags.includes("mesh:ready")),
  );
  const activeLaneKind =
    (activeLane as { lane?: string } | null)?.lane ??
    (activeLane?.source?.kind === "planner" ? activeLane.resolved?.discretization : null);
  const authoringLane = resolveAirboxInspectorAuthoringLane(selection, runtimeStatus);
  const runtimeLane = resolveAirboxInspectorLane(selection, runtimeStatus);
  const effectiveMethod =
    authoringLane === "fdm" || authoringLane === "fem"
      ? authoringLane
      : activeLaneKind === "fdm" || activeLaneKind === "fem"
        ? activeLaneKind
        : null;
  const knownMethod = effectiveMethod === "fdm" || effectiveMethod === "fem";
  const runtimeMatchesAuthoring = runtimeStatus
    ? Boolean(knownMethod && runtimeLane === effectiveMethod)
    : knownMethod;
  const showNewProblem = runtimeStatus?.authoring.state === "missing";
  const showDiagnostics = runtimeStatus !== null ? !runtimeMatchesAuthoring : !knownMethod;
  const studySettingsLabel =
    effectiveMethod === "fdm" ? "Open FDM grid settings" : "Open Study settings";
  const rawReason = runtimeStatus?.authoring.reason?.replace(
    /\b(unknown|unavailable)\b/gi,
    "pending",
  );
  const availabilityMessage = knownMethod
    ? runtimeMatchesAuthoring
      ? `The accepted ${effectiveMethod.toUpperCase()} method is active for outer-domain policy authoring.`
      : `The accepted ${effectiveMethod.toUpperCase()} method is authored; runtime realization remains pending until domain meshing completes.`
    : rawReason || "Choose an explicit FEM or FDM method before configuring the outer domain.";

  const laneLabel =
    effectiveMethod === "fem" ? "FEM" : effectiveMethod === "fdm" ? "FDM" : null;
  const objectCount = objects.length;

  const baseline = useMemo<UniverseRootDraft>(
    () => ({
      name: universeName,
      universeSpanText,
      aabbMinText: aabb ? formatSpanAuto(aabb.min) : null,
      aabbMaxText: aabb ? formatSpanAuto(aabb.max) : null,
      aabbSpanText: aabb ? formatSpanAuto(aabb.span) : null,
      aabbCenterText: aabb ? formatSpanAuto(aabb.center) : null,
      objectCount,
      hasRealizedMesh,
      laneLabel,
    }),
    [aabb, hasRealizedMesh, laneLabel, objectCount, universeName, universeSpanText],
  );

  const runFitUniverse = useCallback(async () => {
    const modelApi = kernel.api.model as unknown as Record<string, unknown>;
    if (typeof modelApi.fitUniverse === "function") {
      await (modelApi.fitUniverse as (body?: Record<string, unknown>) => Promise<unknown>)({
        base_revision: scene.data?.revision ?? null,
      });
    } else if (typeof (kernel.api as unknown as Record<string, unknown>).postJson === "function") {
      await (
        kernel.api as unknown as {
          postJson: (path: string, body: Record<string, unknown>) => Promise<unknown>;
        }
      ).postJson(MODEL_UNIVERSE_FIT_PATH, {
        base_revision: scene.data?.revision ?? null,
      });
    } else if (aabb) {
      const padFactor = 2.0;
      const paddedSize: [number, number, number] = [
        Math.max(aabb.span[0] * padFactor, 10e-9),
        Math.max(aabb.span[1] * padFactor, 10e-9),
        Math.max(aabb.span[2] * padFactor, 10e-9),
      ];
      const { context } = buildModelScopeMutationContext(
        kernel,
        scene.data,
        scene.sessionScopeKey,
      );
      const reqOptions = scene.sessionScopeKey
        ? { sessionScopeKey: scene.sessionScopeKey }
        : undefined;
      const tx = await runAuthoringMutationWithHistory(
        context,
        "Fit universe bounds",
        async ({ baseRevision: capturedRev }) => {
          const payload = {
            base_revision: capturedRev ?? scene.data?.revision ?? null,
            kind: "patch_universe" as const,
            sync_study_universe_mesh: true,
            universe: {
              center: aabb.center,
              size: paddedSize,
            },
          };
          return reqOptions
            ? kernel.api.model.commitTransaction(payload, reqOptions)
            : kernel.api.model.commitTransaction(payload);
        },
      );
      publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
    }
    const rev = fallbackRevision(null);
    kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
    kernel.resources.invalidate(MODEL_UNIVERSE_PATH, rev);
    kernel.resources.invalidate(MESH_SUMMARY_RESOURCE_KEY, rev);
  }, [aabb, kernel, scene.data, scene.sessionScopeKey]);

  const domainShortcuts = useMemo<readonly InspectorShortcutCardItem[]>(
    () => [
      {
        id: "airbox",
        title: "Airbox",
        subtitle: "Outer padding policy, stray-field envelope & mesh parameters",
        ...(laneLabel ? { badge: laneLabel, tone: "info" as const } : {}),
        selection: buildRootSelection("airbox.root", "model:airbox", "Airbox"),
      },
      {
        id: "boundary-faces",
        title: "Boundary Faces",
        subtitle: "Exterior domain faces (±X, ±Y, ±Z) & asymptotic conditions",
        selection: buildRootSelection(
          "boundary-faces.root",
          "model:universe:boundary-faces",
          "Boundary Faces",
        ),
      },
      {
        id: "mesh",
        title: "Mesh",
        subtitle: "Domain discretization & shared-domain conformal build",
        selection: buildRootSelection("mesh.root", "model:mesh", "Mesh"),
      },
      {
        id: "study",
        title: "Study",
        subtitle: "Method selection (FEM / FDM) & solver execution",
        selection: buildRootSelection("study.root", "model:study", "Study"),
      },
    ],
    [laneLabel],
  );

  const spec = useMemo<InspectorSpec<UniverseRootDraft>>(
    () => ({
      id: "model.universe-root",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "universe", label: "Universe" },
        ],
        canFitView: true,
        searchable: false,
        primaryHeaderAction: {
          label: "Fit Airbox to All Objects",
          icon: Maximize2,
          disabledReason:
            objects.length === 0
              ? "Add at least one geometry object before fitting the outer domain."
              : undefined,
          ...(hasRealizedMesh
            ? {
                confirm: {
                  title: "Refit outer universe bounds?",
                  description:
                    "Refitting the computational universe updates the Airbox envelope and marks the current realized mesh stale so it can be rebuilt cleanly.",
                  confirmLabel: "Refit universe",
                },
              }
            : {}),
          onRun: async (ctx) => {
            await runFitUniverse();
            ctx.notify("Universe bounds fitted to scene objects");
          },
        },
      },
      identity: {
        domain: "geometry",
        icon: Globe,
        title: (draft) => draft.name,
        kindLabel: "Computational universe",
        entityId: "model:universe",
        statePill: (draft) =>
          draft.objectCount === 0
            ? { tone: "neutral", label: "Empty scene" }
            : { tone: "ok", label: "Bounded" },
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "span", label: "Domain span", value: draft.universeSpanText },
        { id: "objects", label: "Enclosed objects", value: String(draft.objectCount) },
        { id: "lane", label: "Method", value: draft.laneLabel, tone: "info" },
      ],
      sections: [
        {
          id: "universe-aabb",
          title: "Magnetic bounding box (AABB)",
          icon: Box,
          defaultOpen: true,
          summary: (draft) => draft.aabbSpanText ?? "No authored geometry bounds",
          emptyState: (draft) =>
            draft.objectCount === 0
              ? {
                  icon: Box,
                  title: "No scene objects enclosed",
                  description:
                    "Create a magnetic or conductor geometry primitive to compute the scene bounding box.",
                  action: {
                    label: "Add Box Object",
                    onRun: (ctx) =>
                      ctx.selectNode(buildBuilderPrimitiveSelection("box", "New Box")),
                  },
                }
              : null,
          rows: [
            {
              type: "readonly",
              label: "Universe envelope",
              mono: true,
              showWhen: (d) => Boolean(d.universeSpanText),
              format: (d) => d.universeSpanText ?? "\u2014",
            },
            {
              type: "readonly",
              label: "Enclosed span",
              mono: true,
              showWhen: (d) => Boolean(d.aabbSpanText),
              format: (d) => d.aabbSpanText ?? "\u2014",
            },
            {
              type: "readonly",
              label: "Min corner (x, y, z)",
              mono: true,
              showWhen: (d) => Boolean(d.aabbMinText),
              format: (d) => d.aabbMinText ?? "\u2014",
            },
            {
              type: "readonly",
              label: "Max corner (x, y, z)",
              mono: true,
              showWhen: (d) => Boolean(d.aabbMaxText),
              format: (d) => d.aabbMaxText ?? "\u2014",
            },
            {
              type: "readonly",
              label: "Geometric center",
              mono: true,
              showWhen: (d) => Boolean(d.aabbCenterText),
              format: (d) => d.aabbCenterText ?? "\u2014",
            },
          ],
        },
        {
          id: "universe-method-availability",
          title: "Method & outer-domain availability",
          icon: Sliders,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: () => (
                <div className="flex flex-col gap-2" data-slot="universe-method-availability">
                  <p className="text-xs text-[var(--fm-text-muted)]" role="status">
                    {availabilityMessage}
                  </p>
                  <div
                    aria-label="Universe navigation"
                    className="flex flex-wrap items-center gap-1.5"
                    role="group"
                  >
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() => navigateToStudyRoot(kernel.selection)}
                    >
                      {studySettingsLabel}
                    </Button>
                    {showNewProblem ? (
                      <Button
                        size="sm"
                        type="button"
                        variant="primary"
                        onClick={() => {
                          void kernel.commands.execute(
                            "workspace.new-problem",
                            createCommandContext("inspector", kernel, {
                              sourceDetail: "universe-authoring-availability",
                            }),
                          );
                        }}
                      >
                        Choose method in New Problem
                      </Button>
                    ) : null}
                    {showDiagnostics ? (
                      <Button
                        size="sm"
                        type="button"
                        variant="ghost"
                        onClick={() => kernel.layout.openBottomPanel?.("diagnostics")}
                      >
                        Open diagnostics
                      </Button>
                    ) : null}
                  </div>
                </div>
              ),
            },
          ],
        },
        {
          id: "universe-children",
          title: "Domain sub-resources",
          icon: Shield,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <InspectorShortcutCards items={domainShortcuts} onSelect={ctx.selectNode} />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () =>
          "Outer-domain padding and mesh parameters are edited on the Airbox child node",
      },
    }),
    [
      availabilityMessage,
      domainShortcuts,
      hasRealizedMesh,
      kernel,
      objects.length,
      runFitUniverse,
      showDiagnostics,
      showNewProblem,
      studySettingsLabel,
    ],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 3. ObjectsRootInspectorPanel (`objects.root`) ── */

interface ObjectsRootRow {
  id: string;
  name: string;
  roleLabel: string;
  geometryKind: string;
  materialLabel: string;
  visible: boolean;
  objectRole?: "antenna" | "auxiliary" | "magnet";
}

interface ObjectsRootDraft {
  rows: readonly ObjectsRootRow[];
  magneticCount: number;
  conductorCount: number;
}

const PRIMITIVE_STARTERS: readonly { slug: string; label: string }[] = [
  { slug: "box", label: "Box" },
  { slug: "cylinder", label: "Cylinder" },
  { slug: "ellipsoid", label: "Ellipsoid" },
  { slug: "sphere", label: "Sphere" },
  { slug: "tube", label: "Tube" },
  { slug: "cone", label: "Cone" },
  { slug: "torus", label: "Torus" },
  { slug: "arch_waveguide", label: "Arch Waveguide" },
  { slug: "polygon_extrusion", label: "Polygon Extrusion" },
  { slug: "imported_mesh", label: "Imported Mesh" },
];

export function ObjectsRootInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();

  const materialsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const mat of scene.data?.materials ?? []) {
      map.set(mat.id, mat.name || mat.id);
    }
    return map;
  }, [scene.data?.materials]);

  const rows = useMemo<readonly ObjectsRootRow[]>(() => {
    return (scene.data?.objects ?? [])
      .filter((o) => !isAirboxSceneObject(o))
      .map((obj) => {
        const geom = (obj.geometry ?? null) as Record<string, unknown> | null;
        const geometryKind =
          (typeof geom?.geometry_kind === "string" && geom.geometry_kind) ||
          (typeof geom?.kind === "string" && geom.kind) ||
          "Solid";
        const rawRole = obj.role?.trim().toLowerCase() ?? "magnet";
        const roleLabel =
          rawRole === "antenna"
            ? "Antenna"
            : rawRole === "conductor"
              ? "Conductor"
              : rawRole === "auxiliary" || rawRole === "spacer_dielectric"
                ? "Dielectric"
                : "Magnetic";
        const matRef = obj.material_ref?.trim() ?? "";
        const materialLabel = matRef ? materialsById.get(matRef) ?? matRef : "Unassigned";
        return {
          id: obj.id,
          name: obj.name?.trim() || obj.id,
          roleLabel,
          geometryKind,
          materialLabel,
          visible: obj.visible !== false,
          objectRole:
            rawRole === "antenna" ? "antenna" : rawRole === "auxiliary" ? "auxiliary" : "magnet",
        };
      });
  }, [materialsById, scene.data?.objects]);

  const baseline = useMemo<ObjectsRootDraft>(() => {
    const magneticCount = rows.filter((r) => r.roleLabel === "Magnetic").length;
    const conductorCount = rows.length - magneticCount;
    return { rows, magneticCount, conductorCount };
  }, [rows]);

  const toggleObjectVisibility = useCallback(
    async (objectId: string, nextVisible: boolean) => {
      const updated = await kernel.api.model.patchObject(objectId, {
        base_revision: scene.data?.revision ?? null,
        visible: nextVisible,
      });
      publishCommittedSceneResource(
        kernel.resources,
        updated,
        fallbackRevision(updated.revision),
      );
    },
    [kernel.api.model, kernel.resources, scene.data?.revision],
  );

  const spec = useMemo<InspectorSpec<ObjectsRootDraft>>(
    () => ({
      id: "model.objects-root",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "objects", label: "Objects" },
        ],
        canFitView: rows.length > 0,
        searchable: false,
      },
      identity: {
        domain: "geometry",
        icon: Layers,
        title: () => "Objects",
        kindLabel: "Scene object collection",
        entityId: "model:objects",
        statePill: (draft) =>
          draft.rows.length === 0
            ? { tone: "neutral", label: "0 objects" }
            : { tone: "ok", label: `${draft.rows.length} authored` },
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "total", label: "Total", value: String(draft.rows.length) },
        { id: "magnetic", label: "Magnetic", value: String(draft.magneticCount) },
        {
          id: "other",
          label: "Conductors & antennas",
          value: draft.conductorCount > 0 ? String(draft.conductorCount) : null,
        },
      ],
      sections: [
        {
          id: "objects-create",
          title: "Add geometry primitive",
          icon: Plus,
          defaultOpen: true,
          summary: () => "10 parametric & imported primitives",
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="grid grid-cols-2 gap-1.5" data-slot="primitive-creator-grid">
                  {PRIMITIVE_STARTERS.map((prim) => (
                    <Button
                      key={prim.slug}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        ctx.selectNode(
                          buildBuilderPrimitiveSelection(prim.slug, `New ${prim.label}`),
                        )
                      }
                    >
                      <Plus aria-hidden="true" size={12} />
                      <span className="truncate">{prim.label}</span>
                    </Button>
                  ))}
                </div>
              ),
            },
          ],
        },
        {
          id: "objects-table",
          title: "Authored scene objects",
          icon: Box,
          defaultOpen: true,
          summary: (draft) => `${draft.rows.length} objects`,
          emptyState: (draft) =>
            draft.rows.length === 0
              ? {
                  icon: Box,
                  title: "No objects in session",
                  description:
                    "Choose any primitive above to preview and commit a new 3D object into the scene.",
                  action: {
                    label: "Create Box",
                    onRun: (ctx) =>
                      ctx.selectNode(buildBuilderPrimitiveSelection("box", "New Box")),
                  },
                }
              : null,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.rows.length > 0,
              rowKey: (rawRow) => (rawRow as ObjectsRootRow).id,
              rows: (d) => d.rows,
              onSelectRow: (rawRow, ctx) => {
                const row = rawRow as ObjectsRootRow;
                ctx.selectNode(
                  buildObjectSelection(row.id, "object.root", row.name, {
                    objectRole: row.objectRole,
                  }),
                );
              },
              columns: [
                {
                  id: "name",
                  header: "Object",
                  renderCell: (rawRow) => {
                    const row = rawRow as ObjectsRootRow;
                    return (
                      <div className="flex flex-col">
                        <span className="font-medium text-[var(--fm-text)]">{row.name}</span>
                        <span className="text-xs text-[var(--fm-text-muted)]">
                          {row.roleLabel} · {row.geometryKind}
                        </span>
                      </div>
                    );
                  },
                },
                {
                  id: "material",
                  header: "Material",
                  renderCell: (rawRow) => (
                    <span className="text-xs text-[var(--fm-text-muted)]">
                      {(rawRow as ObjectsRootRow).materialLabel}
                    </span>
                  ),
                },
                {
                  id: "visible",
                  header: "Visible",
                  align: "right",
                  renderCell: (rawRow) => {
                    const row = rawRow as ObjectsRootRow;
                    return (
                      <Switch
                        aria-label={`Toggle visibility for ${row.name}`}
                        checked={row.visible}
                        onCheckedChange={(checked) => {
                          void toggleObjectVisibility(row.id, checked);
                        }}
                      />
                    );
                  },
                },
              ],
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Select an object to inspect its geometry, material, regions, or physics",
      },
    }),
    [rows.length, toggleObjectVisibility],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 4. DefinitionsRootInspectorPanel (`definitions.root` + `model.frozen-spins` redirect) ── */

interface SessionMaterialRow {
  id: string;
  name: string;
  msLabel: string;
  usageCount: number;
}

interface UnscopedFrozenRow {
  id: string;
  name: string;
  enabled: boolean;
}

interface DefinitionsRootDraft {
  materials: readonly SessionMaterialRow[];
  monitorCount: number;
  unscopedFrozen: readonly UnscopedFrozenRow[];
}

export function DefinitionsRootInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const monitors = usePlanarMonitorsResource();
  const frozenSpins = useFrozenSpinsCollectionResource({ enabled: true });
  const [libraryOpen, setLibraryOpen] = useState(false);

  const materials = useMemo<readonly SessionMaterialRow[]>(() => {
    const objects = scene.data?.objects ?? [];
    return (scene.data?.materials ?? []).map((mat) => {
      const usageCount = objects.filter((o) => o.material_ref === mat.id).length;
      const ms = mat.properties?.Ms;
      const msLabel =
        typeof ms === "number" && Number.isFinite(ms)
          ? `${Number((ms / 1e3).toPrecision(4))} kA/m`
          : `α = ${mat.properties?.alpha ?? 0}`;
      return {
        id: mat.id,
        name: mat.name || mat.id,
        msLabel,
        usageCount,
      };
    });
  }, [scene.data?.materials, scene.data?.objects]);

  const unscopedFrozen = useMemo<readonly UnscopedFrozenRow[]>(() => {
    return (frozenSpins.data?.definitions ?? [])
      .filter((def) => isUnscopedFrozenSelector(def.selector))
      .map((def) => ({
        id: def.id,
        name: def.name || def.id,
        enabled: def.enabled !== false,
      }));
  }, [frozenSpins.data?.definitions]);

  const monitorCount = monitors.data?.monitors?.length ?? 0;

  const baseline = useMemo<DefinitionsRootDraft>(
    () => ({
      materials,
      monitorCount,
      unscopedFrozen,
    }),
    [materials, monitorCount, unscopedFrozen],
  );

  const handleCreateCustomMaterial = useCallback(async () => {
    const index = (scene.data?.materials?.length ?? 0) + 1;
    const matId = `custom-material-${index}-${Date.now().toString(36)}`;
    const tx = await kernel.api.model.createMaterial(
      matId,
      `Custom Material ${index}`,
      { Ms: 8.0e5, Aex: 13e-12, alpha: 0.008 },
      [],
      { baseRevision: scene.data?.revision ?? undefined },
    );
    publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
  }, [kernel.api.model, kernel.resources, scene.data?.materials?.length, scene.data?.revision]);

  const handleCreateGlobalFrozenSpins = useCallback(
    async (selectNode: (next: Omit<Selection, "moduleSource">) => void) => {
      const id = `frozen-global-${Date.now().toString(36)}`;
      const expectedRev = frozenSpins.data?.revision ?? scene.data?.revision ?? 0;
      await kernel.api.model.frozenSpins.create({
        expected_revision: expectedRev,
        definition: {
          id,
          name: "Global Frozen Spins",
          enabled: true,
          schema_version: "fullmag.frozen-spins.v1",
          selector: { kind: "all_magnetic" },
          reference: { kind: "capture_current_at_activation" },
          membership: { kind: "static" },
          activation: { kind: "all_stages" },
        },
      });
      kernel.resources.invalidate(MODEL_FROZEN_SPINS_PATH, fallbackRevision(expectedRev + 1));
      const nodeId = `model:definitions:frozen-spins:${encodeURIComponent(id)}`;
      selectNode({
        kind: "object.frozen-spins",
        label: "Global Frozen Spins",
        nodeId,
        objectId: null,
        ref: null,
      });
    },
    [frozenSpins.data?.revision, kernel.api.model.frozenSpins, kernel.resources, scene.data?.revision],
  );

  const spec = useMemo<InspectorSpec<DefinitionsRootDraft>>(
    () => ({
      id: "model.definitions-root",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "definitions", label: "Definitions" },
        ],
        searchable: false,
        primaryHeaderAction: {
          label: "Material Library",
          icon: BookOpen,
          onRun: () => setLibraryOpen(true),
        },
      },
      identity: {
        domain: "definition",
        icon: BookOpen,
        title: () => "Definitions",
        kindLabel: "Reusable model definitions",
        entityId: "model:definitions",
        statePill: (draft) => ({
          tone: "ok",
          label: `${draft.materials.length} materials`,
        }),
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "materials", label: "Materials", value: String(draft.materials.length) },
        { id: "monitors", label: "Planar monitors", value: String(draft.monitorCount) },
        {
          id: "frozen",
          label: "Global constraints",
          value: String(draft.unscopedFrozen.length),
        },
      ],
      sections: [
        {
          id: "definitions-materials",
          title: "Session materials",
          icon: Magnet,
          defaultOpen: true,
          summary: (d) => `${d.materials.length} materials in session`,
          emptyState: (d) =>
            d.materials.length === 0
              ? {
                  icon: Magnet,
                  title: "No session materials defined",
                  description:
                    "Create a custom magnetic material or import a curated standard from the Material Library.",
                  action: {
                    label: "Create Custom Material",
                    onRun: () => void handleCreateCustomMaterial(),
                  },
                }
              : null,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.materials.length > 0,
              rowKey: (rawRow) => (rawRow as SessionMaterialRow).id,
              rows: (d) => d.materials,
              columns: [
                {
                  id: "name",
                  header: "Material",
                  renderCell: (rawRow) => (
                    <span className="font-medium text-[var(--fm-text)]">
                      {(rawRow as SessionMaterialRow).name}
                    </span>
                  ),
                },
                {
                  id: "ms",
                  header: "Summary",
                  mono: true,
                  renderCell: (rawRow) => (rawRow as SessionMaterialRow).msLabel,
                },
                {
                  id: "used",
                  header: "Used by",
                  align: "right",
                  renderCell: (rawRow) =>
                    `${(rawRow as SessionMaterialRow).usageCount} obj`,
                },
              ],
            },
          ],
          footer: () => (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() => void handleCreateCustomMaterial()}
              >
                <Plus aria-hidden="true" size={12} />
                <span>New Custom Material</span>
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setLibraryOpen(true)}
              >
                <BookOpen aria-hidden="true" size={12} />
                <span>Open Material Library</span>
              </Button>
            </div>
          ),
        },
        {
          id: "definitions-monitors",
          title: "Planar monitors",
          icon: Compass,
          defaultOpen: true,
          summary: (d) => `${d.monitorCount} spatial monitors`,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <InspectorShortcutCards
                  items={[
                    {
                      id: "planar-monitors",
                      title: "Planar Monitors",
                      subtitle: "2D slice & midplane observable monitors",
                      badge: `${ctx.draft.monitorCount}`,
                      selection: buildRootSelection(
                        "model.planar.monitors",
                        "model:definitions:planar-monitors",
                        "Planar Monitors",
                      ),
                    },
                  ]}
                  onSelect={ctx.selectNode}
                />
              ),
            },
          ],
          footer: () => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => {
                void kernel.commands.execute(
                  "planar-monitor.create",
                  createCommandContext("inspector", kernel),
                );
              }}
            >
              <Plus aria-hidden="true" size={12} />
              <span>Add Planar Monitor</span>
            </Button>
          ),
        },
        {
          id: "definitions-frozen-spins",
          title: "Global frozen spins constraints",
          icon: Shield,
          defaultOpen: true,
          summary: (d) => `${d.unscopedFrozen.length} unscoped constraints`,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.unscopedFrozen.length > 0,
              rowKey: (rawRow) => (rawRow as UnscopedFrozenRow).id,
              rows: (d) => d.unscopedFrozen,
              onSelectRow: (rawRow, ctx) => {
                const row = rawRow as UnscopedFrozenRow;
                ctx.selectNode({
                  kind: "object.frozen-spins",
                  label: row.name,
                  nodeId: `model:definitions:frozen-spins:${encodeURIComponent(row.id)}`,
                  objectId: null,
                  ref: null,
                });
              },
              columns: [
                {
                  id: "name",
                  header: "Constraint",
                  renderCell: (rawRow) => (
                    <span className="font-medium text-[var(--fm-text)]">
                      {(rawRow as UnscopedFrozenRow).name}
                    </span>
                  ),
                },
                {
                  id: "state",
                  header: "State",
                  align: "right",
                  renderCell: (rawRow) => {
                    const row = rawRow as UnscopedFrozenRow;
                    return (
                      <Badge data-tone={row.enabled ? "ok" : "neutral"}>
                        {row.enabled ? "Active" : "Disabled"}
                      </Badge>
                    );
                  },
                },
              ],
            },
          ],
          footer: (ctx) => (
            <Button
              size="sm"
              type="button"
              variant="secondary"
              onClick={() => void handleCreateGlobalFrozenSpins(ctx.selectNode)}
            >
              <Plus aria-hidden="true" size={12} />
              <span>Add Global Frozen Spins</span>
            </Button>
          ),
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Select a definition or open the Material Library to author assets",
      },
    }),
    [handleCreateCustomMaterial, handleCreateGlobalFrozenSpins, kernel],
  );

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <MaterialLibraryDialog open={libraryOpen} onOpenChange={setLibraryOpen} />
    </SpecInspectorHost>
  );
}

/* ── 5. GlobalPhysicsScopeInspectorPanel (`physics.scope.global`) ── */

interface GlobalTermRow {
  id: string;
  moduleKind: string;
  label: string;
  subtitle: string;
  enabled: boolean;
}

interface GlobalPhysicsDraft {
  terms: readonly GlobalTermRow[];
  activeCount: number;
  fieldDriveCount: number;
  couplingCount: number;
}

export function GlobalPhysicsScopeInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();
  const fieldDrives = useFieldDrivesResource();

  const studyRec = (scene.data?.study ?? null) as Record<string, unknown> | null;
  const graphModules = useMemo(() => {
    const g = (physicsGraph.data ?? null) as Record<string, unknown> | null;
    return Array.isArray(g?.modules) ? (g.modules as Record<string, unknown>[]) : [];
  }, [physicsGraph.data]);

  const terms = useMemo<readonly GlobalTermRow[]>(() => {
    const findMod = (kind: string) =>
      graphModules.find((m) => m.kind === kind || m.id === kind);
    const isModActive = (kind: string, fallback: boolean) => {
      const mod = findMod(kind);
      if (mod && typeof mod.activation === "string") {
        return mod.activation === "active";
      }
      return fallback;
    };

    const demagEnabled =
      typeof studyRec?.demag_enabled === "boolean"
        ? studyRec.demag_enabled
        : isModActive("demag", true);
    const zeemanEnabled =
      Array.isArray(studyRec?.external_field) || isModActive("zeeman", false);
    const pbcRec =
      studyRec?.pbc && typeof studyRec.pbc === "object"
        ? (studyRec.pbc as Record<string, unknown>)
        : null;
    const pbcEnabled =
      Boolean(pbcRec) ||
      Boolean(studyRec?.periodic_boundary_conditions) ||
      isModActive("periodic_bc", false);
    const thermalRec =
      studyRec?.thermal_noise && typeof studyRec.thermal_noise === "object"
        ? (studyRec.thermal_noise as Record<string, unknown>)
        : null;
    const thermalEnabled =
      (thermalRec !== null &&
        typeof thermalRec.temperature === "number" &&
        thermalRec.temperature > 0) ||
      (typeof studyRec?.temperature_k === "number" && studyRec.temperature_k > 0) ||
      isModActive("thermal_noise", false);
    const rotatedDmiVal = studyRec?.rotated_interfacial_dmi;
    const rotatedDmiEnabled =
      (typeof rotatedDmiVal === "number" && Number.isFinite(rotatedDmiVal)) ||
      (typeof rotatedDmiVal === "string" &&
        rotatedDmiVal.trim() !== "" &&
        Number.isFinite(Number(rotatedDmiVal))) ||
      isModActive("rotated_interfacial_dmi", false);

    return [
      {
        id: findMod("demag")?.id ? String(findMod("demag")!.id) : "demag",
        moduleKind: "demag",
        label: "Demagnetization (stray field)",
        subtitle: "Long-range magnetostatic dipole-dipole field",
        enabled: demagEnabled,
      },
      {
        id: findMod("zeeman")?.id ? String(findMod("zeeman")!.id) : "zeeman",
        moduleKind: "zeeman",
        label: "External magnetic field (Zeeman)",
        subtitle: "Uniform static bias field B_ext across the domain",
        enabled: zeemanEnabled,
      },
      {
        id: findMod("periodic_bc")?.id ? String(findMod("periodic_bc")!.id) : "periodic_bc",
        moduleKind: "periodic_bc",
        label: "Periodic boundary conditions",
        subtitle: "1D, 2D, or 3D translational periodicity",
        enabled: pbcEnabled,
      },
      {
        id: findMod("thermal_noise")?.id ? String(findMod("thermal_noise")!.id) : "thermal_noise",
        moduleKind: "thermal_noise",
        label: "Thermal fluctuations (Brown)",
        subtitle: "Stochastic Langevin field at finite temperature T",
        enabled: thermalEnabled,
      },
      {
        id: findMod("rotated_interfacial_dmi")?.id
          ? String(findMod("rotated_interfacial_dmi")!.id)
          : "rotated_interfacial_dmi",
        moduleKind: "rotated_interfacial_dmi",
        label: "Rotated interfacial DMI",
        subtitle: "Global symmetry-broken chiral exchange frame",
        enabled: rotatedDmiEnabled,
      },
    ];
  }, [graphModules, studyRec]);

  const fieldDriveCount = extractFieldDriveItems(fieldDrives.data).length;
  const couplingCount = scene.data?.couplings?.length ?? 0;

  const baseline = useMemo<GlobalPhysicsDraft>(
    () => ({
      terms,
      activeCount: terms.filter((t) => t.enabled).length,
      fieldDriveCount,
      couplingCount,
    }),
    [couplingCount, fieldDriveCount, terms],
  );

  const handleToggleTerm = useCallback(
    async (moduleKind: string, nextEnabled: boolean) => {
      const patch: JsonObject = {};
      if (moduleKind === "demag") {
        patch.demag_enabled = nextEnabled;
      } else if (moduleKind === "thermal_noise") {
        const existingThermal =
          studyRec?.thermal_noise && typeof studyRec.thermal_noise === "object"
            ? (studyRec.thermal_noise as Record<string, unknown>)
            : null;
        const prevTemp =
          typeof existingThermal?.temperature === "number" && existingThermal.temperature > 0
            ? existingThermal.temperature
            : 300;
        const prevSeed =
          typeof existingThermal?.seed === "string" && existingThermal.seed.trim()
            ? existingThermal.seed.trim()
            : undefined;
        patch.thermal_noise = nextEnabled
          ? {
              temperature: prevTemp,
              ...(prevSeed ? { seed: prevSeed } : {}),
            }
          : null;
      } else if (moduleKind === "zeeman") {
        patch.external_field = nextEnabled
          ? Array.isArray(studyRec?.external_field) && studyRec.external_field.length === 3
            ? (studyRec.external_field as number[])
            : [0, 0, 0.01]
          : null;
      } else if (moduleKind === "periodic_bc") {
        patch.pbc = nextEnabled
          ? {
              axes: ["periodic", "open", "open"],
              demag: "macro_geometry",
            }
          : null;
      } else if (moduleKind === "rotated_interfacial_dmi") {
        const existingDmi = studyRec?.rotated_interfacial_dmi;
        const defaultDmi =
          typeof existingDmi === "number" && Number.isFinite(existingDmi)
            ? existingDmi
            : 0.003;
        patch.rotated_interfacial_dmi = nextEnabled ? defaultDmi : null;
      }
      const { context } = buildModelScopeMutationContext(
        kernel,
        scene.data,
        scene.sessionScopeKey,
      );
      const reqOptions = scene.sessionScopeKey
        ? { sessionScopeKey: scene.sessionScopeKey }
        : undefined;
      const tx = await runAuthoringMutationWithHistory(
        context,
        `${nextEnabled ? "Enable" : "Disable"} ${moduleKind}`,
        async ({ baseRevision: capturedRev }) => {
          const payload = {
            kind: "merge_patch" as const,
            base_revision: capturedRev ?? scene.data?.revision ?? 0,
            merge_patch: { study: patch },
          };
          return reqOptions
            ? kernel.api.model.commitTransaction(payload, reqOptions)
            : kernel.api.model.commitTransaction(payload);
        },
      );
      publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
      kernel.resources.invalidate(MODEL_STUDY_PATH, tx.scene_revision);
      kernel.resources.invalidate(MODEL_SCENE_PATH, tx.scene_revision);
      kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, tx.scene_revision);
    },
    [kernel, scene.data, scene.sessionScopeKey, studyRec],
  );

  const spec = useMemo<InspectorSpec<GlobalPhysicsDraft>>(
    () => ({
      id: "physics.scope.global",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "global-physics", label: "Global Physics" },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: Activity,
        title: () => "Global Physics",
        kindLabel: "Global Hamiltonian scope",
        entityId: "model:physics:global",
        statePill: (draft) => ({
          tone: draft.activeCount > 0 ? "ok" : "neutral",
          label: `${draft.activeCount} active`,
        }),
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "active", label: "Active terms", value: String(draft.activeCount) },
        { id: "drives", label: "Field drives", value: String(draft.fieldDriveCount) },
        { id: "couplings", label: "Couplings", value: String(draft.couplingCount) },
      ],
      sections: [
        {
          id: "global-physics-matrix",
          title: "Global interaction switches",
          icon: Sliders,
          defaultOpen: true,
          summary: (d) => `${d.activeCount} of ${d.terms.length} enabled`,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-col gap-1.5" data-slot="global-physics-switches">
                  {ctx.draft.terms.map((term) => {
                    const nodeId = `model:physics:global:module:${encodeURIComponent(term.id)}`;
                    return (
                      <div
                        key={term.moduleKind}
                        className="flex items-center justify-between gap-2 rounded-md border border-[var(--fm-border)] bg-[var(--fm-surface-2)] px-2.5 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-[var(--fm-text)]">
                            {term.label}
                          </div>
                          <div className="truncate text-xs text-[var(--fm-text-muted)]">
                            {term.subtitle}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Switch
                            aria-label={`Toggle ${term.label}`}
                            checked={term.enabled}
                            onCheckedChange={(checked) => {
                              void handleToggleTerm(term.moduleKind, checked);
                            }}
                          />
                          <Button
                            aria-label={`Configure ${term.label}`}
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              ctx.selectNode({
                                kind: "physics.module",
                                label: term.label,
                                nodeId,
                                objectId: null,
                                ref: {
                                  kind: "physics.module",
                                  nodeId,
                                  physicsActivation: term.enabled ? "active" : "inactive",
                                  physicsModuleId: term.id,
                                  physicsModuleKind: term.moduleKind,
                                  physicsScopeKind: "global",
                                  type: "physics-module",
                                },
                              })
                            }
                          >
                            <ArrowRight aria-hidden="true" size={12} />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ),
            },
          ],
        },
        {
          id: "global-physics-collections",
          title: "Excitations & inter-object couplings",
          icon: Waves,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <InspectorShortcutCards
                  items={[
                    {
                      id: "field-drives",
                      title: "Field Drives",
                      subtitle: "Time-dependent RF pulses, harmonics & spatial masks",
                      badge: `${ctx.draft.fieldDriveCount}`,
                      selection: buildRootSelection(
                        "physics.field-drives",
                        "model:physics:field-drives",
                        "Field Drives",
                      ),
                    },
                    {
                      id: "couplings",
                      title: "Couplings",
                      subtitle: "RKKY, interlayer exchange & surface exchange",
                      badge: `${ctx.draft.couplingCount}`,
                      selection: buildRootSelection(
                        "physics.couplings",
                        "model:physics:couplings",
                        "Couplings",
                      ),
                    },
                  ]}
                  onSelect={ctx.selectNode}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () =>
          "Switches commit immediately; select a child module to edit its field parameters",
      },
    }),
    [handleToggleTerm],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 6. CrossObjectPhysicsScopeInspectorPanel (`physics.scope.cross-object`) ── */

interface CrossObjectLinkRow {
  id: string;
  label: string;
  kindLabel: string;
  endpointsLabel: string;
  selection: Omit<Selection, "moduleSource">;
}

interface CrossObjectDraft {
  links: readonly CrossObjectLinkRow[];
}

export function CrossObjectPhysicsScopeInspectorPanel({ selection }: InspectorPanelProps) {
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();

  const links = useMemo<readonly CrossObjectLinkRow[]>(() => {
    const items: CrossObjectLinkRow[] = [];
    for (const cpl of scene.data?.couplings ?? []) {
      const rec = cpl as Record<string, unknown>;
      const id = String(rec.id ?? "");
      const kind = String(rec.kind ?? "rkky");
      const epA = (rec.endpoint_a ?? rec.side_a ?? null) as Record<string, unknown> | null;
      const epB = (rec.endpoint_b ?? rec.side_b ?? null) as Record<string, unknown> | null;
      const aLabel = String(epA?.object_id ?? epA?.region_id ?? "Side A");
      const bLabel = String(epB?.object_id ?? epB?.region_id ?? "Side B");
      const nodeId = `model:physics:couplings:${id}`;
      items.push({
        id: `cpl:${id}`,
        label: String(rec.name ?? id),
        kindLabel: kind.toUpperCase(),
        endpointsLabel: `${aLabel} \u2194 ${bLabel}`,
        selection: {
          kind: "physics.coupling",
          label: String(rec.name ?? id),
          nodeId,
          objectId: null,
          ref: {
            couplingId: id,
            kind: "physics.coupling",
            nodeId,
            type: "physics-coupling",
          },
        },
      });
    }

    const g = (physicsGraph.data ?? null) as Record<string, unknown> | null;
    const mods = Array.isArray(g?.modules) ? (g.modules as Record<string, unknown>[]) : [];
    for (const mod of mods) {
      if (mod.kind !== "spin_interface") continue;
      const id = String(mod.id ?? "interface");
      const scopes = Array.isArray(mod.applies_to)
        ? (mod.applies_to as Record<string, unknown>[])
        : [];
      const first = scopes[0];
      const sideA = (first?.side_a ?? null) as Record<string, unknown> | null;
      const sideB = (first?.side_b ?? null) as Record<string, unknown> | null;
      const endpointsLabel =
        sideA || sideB
          ? `${String(sideA?.object_id ?? "HM")} \u2194 ${String(sideB?.object_id ?? "FM")}`
          : "HM \u2194 FM";
      const nodeId = `model:physics:cross-object:module:${encodeURIComponent(id)}`;
      items.push({
        id: `si:${id}`,
        label: String(mod.label ?? mod.name ?? id),
        kindLabel: "HM/FM Interface",
        endpointsLabel,
        selection: {
          kind: "physics.spin-interface",
          label: String(mod.label ?? id),
          nodeId,
          objectId: null,
          ref: {
            kind: "physics.spin-interface",
            nodeId,
            spinInterfaceId: id,
            type: "spin-interface",
          },
        },
      });
    }
    return items;
  }, [physicsGraph.data, scene.data?.couplings]);

  const baseline = useMemo<CrossObjectDraft>(() => ({ links }), [links]);

  const spec = useMemo<InspectorSpec<CrossObjectDraft>>(
    () => ({
      id: "physics.scope.cross-object",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "cross-object", label: "Cross-object Interfaces" },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: Link2,
        title: () => "Cross-object Interfaces",
        kindLabel: "Inter-object physics scope",
        entityId: "model:physics:cross-object",
        statePill: (draft) => ({
          tone: draft.links.length > 0 ? "ok" : "neutral",
          label: `${draft.links.length} links`,
        }),
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "links", label: "Active links", value: String(draft.links.length) },
      ],
      sections: [
        {
          id: "cross-object-actions",
          title: "Create interface interaction",
          icon: Plus,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="flex flex-wrap gap-1.5">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      ctx.selectNode(
                        buildRootSelection(
                          "physics.couplings",
                          "model:physics:couplings",
                          "Couplings",
                        ),
                      )
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add Surface Coupling</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      ctx.selectNode({
                        kind: "physics.spin-interface",
                        label: "New HM/FM interface",
                        nodeId: "model:physics:spin-interface:draft",
                        objectId: null,
                        ref: {
                          draft: true,
                          kind: "physics.spin-interface",
                          nodeId: "model:physics:spin-interface:draft",
                          type: "spin-interface",
                        },
                      })
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add HM/FM Spin Interface</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "cross-object-links",
          title: "Authored cross-object links",
          icon: Link2,
          defaultOpen: true,
          emptyState: (d) =>
            d.links.length === 0
              ? {
                  icon: Link2,
                  title: "No cross-object links configured",
                  description:
                    "Add an RKKY / interlayer exchange surface coupling or an HM/FM spin-mixing interface.",
                }
              : null,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.links.length > 0,
              rowKey: (rawRow) => (rawRow as CrossObjectLinkRow).id,
              rows: (d) => d.links,
              onSelectRow: (rawRow, ctx) =>
                ctx.selectNode((rawRow as CrossObjectLinkRow).selection),
              columns: [
                {
                  id: "label",
                  header: "Interface",
                  renderCell: (rawRow) => (
                    <span className="font-medium text-[var(--fm-text)]">
                      {(rawRow as CrossObjectLinkRow).label}
                    </span>
                  ),
                },
                {
                  id: "kind",
                  header: "Kind",
                  renderCell: (rawRow) => (rawRow as CrossObjectLinkRow).kindLabel,
                },
                {
                  id: "endpoints",
                  header: "Endpoints",
                  mono: true,
                  renderCell: (rawRow) => (rawRow as CrossObjectLinkRow).endpointsLabel,
                },
              ],
            },
          ],
        },
      ],
      commitBar: {
        mode: "readOnly",
        statusMessage: () => "Select a link to edit its coupling constants or mixing conductance",
      },
    }),
    [],
  );

  return <SpecInspectorHost baseline={baseline} selection={selection} spec={spec} />;
}

/* ── 7. PhysicsCouplingsInspectorPanel (`physics.couplings`) ── */

interface CouplingListRow {
  id: string;
  name: string;
  kindLabel: string;
  endpointsLabel: string;
  strengthLabel: string;
  enabled: boolean;
}

interface CouplingsRootDraft {
  rows: readonly CouplingListRow[];
}

export function PhysicsCouplingsInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const couplingsResource = useModelCouplingsResource();
  const [pendingDelete, setPendingDelete] = useState<CouplingListRow | null>(null);

  const rows = useMemo<readonly CouplingListRow[]>(() => {
    const rawList =
      (couplingsResource.data as { couplings?: unknown[]; items?: unknown[] } | null)?.couplings ??
      (couplingsResource.data as { items?: unknown[] } | null)?.items ??
      scene.data?.couplings ??
      [];
    return rawList.map((entry) => {
      const rec = entry as Record<string, unknown>;
      const id = String(rec.coupling_id ?? rec.id ?? "");
      const kind = String(rec.coupling_kind ?? rec.kind ?? "rkky");
      const epA = (rec.source ?? rec.endpoint_a ?? rec.side_a ?? null) as Record<
        string,
        unknown
      > | null;
      const epB = (rec.target ?? rec.endpoint_b ?? rec.side_b ?? null) as Record<
        string,
        unknown
      > | null;
      const aObj = String(epA?.object ?? epA?.object_id ?? epA?.region_id ?? "A");
      const bObj = String(epB?.object ?? epB?.object_id ?? epB?.region_id ?? "B");
      const params = (rec.parameters ?? rec.params ?? rec) as Record<string, unknown>;
      const j1 =
        typeof params.j1 === "number"
          ? params.j1
          : typeof params.j_rkky === "number"
            ? params.j_rkky
            : typeof params.sigma === "number"
              ? params.sigma
              : null;
      const strengthLabel =
        j1 !== null && Number.isFinite(j1)
          ? `${Number((j1 * 1e3).toPrecision(3))} mJ/m\u00b2`
          : kind;
      return {
        id,
        name: String(rec.name ?? id),
        kindLabel:
          kind === "interlayer_exchange"
            ? "Interlayer (J1+J2)"
            : kind === "exchange"
              ? "Direct Exchange"
              : "RKKY",
        endpointsLabel: `${aObj} \u2194 ${bObj}`,
        strengthLabel,
        enabled: rec.enabled !== false,
      };
    });
  }, [couplingsResource.data, scene.data?.couplings]);

  const baseline = useMemo<CouplingsRootDraft>(() => ({ rows }), [rows]);

  const magneticObjects = useMemo(
    () =>
      (scene.data?.objects ?? []).filter(
        (o) => !isAirboxSceneObject(o) && o.role !== "antenna" && o.role !== "auxiliary",
      ),
    [scene.data?.objects],
  );

  const handleCreateCoupling = useCallback(
    async (
      kind: "rkky" | "interlayer_exchange" | "exchange",
      selectNode: (next: Omit<Selection, "moduleSource">) => void,
    ) => {
      const id = `${kind.replace(/_/g, "-")}-${Date.now().toString(36)}`;
      if (magneticObjects.length >= 2) {
        const a = magneticObjects[0]!;
        const b = magneticObjects[1]!;
        const couplingPayload: SceneCoupling = {
          coupling_id: id,
          kind,
          enabled: true,
          source: { kind: "object", object: a.id },
          target: { kind: "object", object: b.id },
          parameters:
            kind === "rkky"
              ? { kind: "rkky", j1: -1e-3 }
              : kind === "interlayer_exchange"
                ? { kind: "interlayer_exchange", j1: -1e-3, j2: -0.2e-3 }
                : { kind: "exchange", mode: "harmonic_mean" },
        };
        const tx = await kernel.api.model.createCoupling(couplingPayload, {
          baseRevision: scene.data?.revision ?? undefined,
        });
        publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
        kernel.resources.invalidate(MODEL_COUPLINGS_PATH, tx.scene_revision);
      }
      const nodeId = `model:physics:couplings:${id}`;
      selectNode({
        kind: "physics.coupling",
        label: id,
        nodeId,
        objectId: null,
        ref: {
          couplingId: id,
          kind: "physics.coupling",
          nodeId,
          type: "physics-coupling",
        },
      });
    },
    [kernel.api.model, kernel.resources, magneticObjects, scene.data?.revision],
  );

  const handleToggleCoupling = useCallback(
    async (couplingId: string, enabled: boolean) => {
      const patchPayload: SceneCouplingPatch = { enabled };
      const tx = await kernel.api.model.patchCoupling(
        couplingId,
        patchPayload,
        { baseRevision: scene.data?.revision ?? undefined },
      );
      publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
      kernel.resources.invalidate(MODEL_COUPLINGS_PATH, tx.scene_revision);
    },
    [kernel.api.model, kernel.resources, scene.data?.revision],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    const tx = await kernel.api.model.deleteCoupling(id, {
      baseRevision: scene.data?.revision ?? undefined,
    });
    publishCommittedSceneResource(kernel.resources, tx.committed_scene, tx.scene_revision);
    kernel.resources.invalidate(MODEL_COUPLINGS_PATH, tx.scene_revision);
  }, [kernel.api.model, kernel.resources, pendingDelete, scene.data?.revision]);

  const spec = useMemo<InspectorSpec<CouplingsRootDraft>>(
    () => ({
      id: "physics.couplings-root",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "couplings", label: "Couplings" },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: Link2,
        title: () => "Couplings",
        kindLabel: "Surface & interlayer couplings",
        entityId: "model:physics:couplings",
        statePill: (draft) => ({
          tone: draft.rows.length > 0 ? "ok" : "neutral",
          label: `${draft.rows.length} couplings`,
        }),
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "count", label: "Total", value: String(draft.rows.length) },
        {
          id: "active",
          label: "Active",
          value: String(draft.rows.filter((r) => r.enabled).length),
        },
      ],
      sections: [
        {
          id: "couplings-create",
          title: "Add surface coupling",
          icon: Plus,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="grid grid-cols-1 gap-1.5" data-slot="coupling-creator-tiles">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => void handleCreateCoupling("rkky", ctx.selectNode)}
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add RKKY Bilinear Coupling</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => void handleCreateCoupling("interlayer_exchange", ctx.selectNode)}
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add Interlayer Exchange (J1 + J2)</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => void handleCreateCoupling("exchange", ctx.selectNode)}
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Add Direct Surface Exchange</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "couplings-table",
          title: "Configured couplings",
          icon: Link2,
          defaultOpen: true,
          emptyState: (d) =>
            d.rows.length === 0
              ? {
                  icon: Link2,
                  title: "No surface couplings defined",
                  description:
                    "Choose a coupling family above to link two magnetic objects or regions across a shared or separated interface.",
                }
              : null,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.rows.length > 0,
              rowKey: (rawRow) => (rawRow as CouplingListRow).id,
              rows: (d) => d.rows,
              onSelectRow: (rawRow, ctx) => {
                const row = rawRow as CouplingListRow;
                const nodeId = `model:physics:couplings:${row.id}`;
                ctx.selectNode({
                  kind: "physics.coupling",
                  label: row.name,
                  nodeId,
                  objectId: null,
                  ref: {
                    couplingId: row.id,
                    kind: "physics.coupling",
                    nodeId,
                    type: "physics-coupling",
                  },
                });
              },
              columns: [
                {
                  id: "name",
                  header: "Coupling",
                  renderCell: (rawRow) => {
                    const row = rawRow as CouplingListRow;
                    return (
                      <div className="flex flex-col">
                        <span className="font-medium text-[var(--fm-text)]">{row.name}</span>
                        <span className="text-xs text-[var(--fm-text-muted)]">
                          {row.kindLabel} · {row.endpointsLabel}
                        </span>
                      </div>
                    );
                  },
                },
                {
                  id: "strength",
                  header: "Strength",
                  mono: true,
                  renderCell: (rawRow) => (rawRow as CouplingListRow).strengthLabel,
                },
                {
                  id: "actions",
                  header: "Active",
                  align: "right",
                  renderCell: (rawRow) => {
                    const row = rawRow as CouplingListRow;
                    return (
                      <div className="flex items-center justify-end gap-1.5">
                        <Switch
                          aria-label={`Toggle ${row.name}`}
                          checked={row.enabled}
                          onCheckedChange={(checked) => {
                            void handleToggleCoupling(row.id, checked);
                          }}
                        />
                        <Button
                          aria-label={`Delete ${row.name}`}
                          size="icon"
                          type="button"
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete(row);
                          }}
                        >
                          <Trash2 aria-hidden="true" size={13} />
                        </Button>
                      </div>
                    );
                  },
                },
              ],
            },
          ],
        },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () => "Select a coupling to edit endpoints and J1 / J2 constants",
      },
    }),
    [handleCreateCoupling, handleToggleCoupling],
  );

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete coupling &ldquo;{pendingDelete?.name ?? ""}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the surface coupling definition from the session model.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmDelete()}>
              Delete coupling
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SpecInspectorHost>
  );
}

/* ── 8. FieldDrivesInspectorPanel (`physics.field-drives`) ── */

interface FieldDriveSummaryRow {
  id: string;
  label: string;
  driveKind: "regional" | "mask";
  waveformLabel: string;
  targetLabel: string;
  enabled: boolean;
  regionalDrive?: RegionalFieldDriveResource;
  maskDrive?: MaskFieldDriveResource;
}

interface FieldDrivesRootDraft {
  rows: readonly FieldDriveSummaryRow[];
}

export function FieldDrivesInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const regionalDrives = useFieldDrivesResource();
  const maskDrives = useMaskFieldDrivesResource();
  const [pendingDelete, setPendingDelete] = useState<FieldDriveSummaryRow | null>(null);

  const rows = useMemo<readonly FieldDriveSummaryRow[]>(() => {
    const items: FieldDriveSummaryRow[] = [];
    const typedRegional = regionalDrives.data?.drives ?? [];
    for (const rec of extractFieldDriveItems(regionalDrives.data)) {
      const id = String(rec.id ?? "");
      const wf = (rec.waveform ?? null) as Record<string, unknown> | null;
      const target = (rec.target ?? null) as Record<string, unknown> | null;
      const targetLabel =
        target?.kind === "global"
          ? "Global"
          : String(target?.object_id ?? target?.region_id ?? "Scoped");
      const matchedTyped = typedRegional.find((d) => d.id === id);
      items.push({
        id,
        label: String(rec.name ?? id),
        driveKind: "regional",
        waveformLabel: String(wf?.kind ?? "waveform").replace(/_/g, " "),
        targetLabel,
        enabled: rec.enabled !== false,
        ...(matchedTyped ? { regionalDrive: matchedTyped } : {}),
      });
    }
    const typedMask = maskDrives.data?.drives ?? [];
    for (const rec of extractFieldDriveItems(maskDrives.data)) {
      const id = String(rec.id ?? "");
      const wf = (rec.waveform ?? null) as Record<string, unknown> | null;
      const matchedTyped = typedMask.find((d) => d.id === id);
      items.push({
        id,
        label: String(rec.name ?? id),
        driveKind: "mask",
        waveformLabel: String(wf?.kind ?? "mask").replace(/_/g, " "),
        targetLabel: String(rec.object_id ?? "Mask"),
        enabled: rec.enabled !== false,
        ...(matchedTyped ? { maskDrive: matchedTyped } : {}),
      });
    }
    return items;
  }, [maskDrives.data, regionalDrives.data]);

  const baseline = useMemo<FieldDrivesRootDraft>(() => ({ rows }), [rows]);

  const openNewDriveDraft = useCallback(
    (
      driveKind: "regional" | "mask",
      label: string,
      selectNode: (next: Omit<Selection, "moduleSource">) => void,
      waveformHint?: "sinc_pulse" | "sinusoidal" | "gaussian_pulse",
    ) => {
      const nodeId =
        driveKind === "regional" && waveformHint
          ? `model:physics:field-drives:draft:regional:${waveformHint}`
          : `model:physics:field-drives:draft:${driveKind}`;
      selectNode({
        kind: "physics.field-drive",
        label,
        nodeId,
        objectId: null,
        ref: {
          draft: true,
          ...(driveKind === "mask" ? { fieldDriveKind: "mask" as const } : {}),
          kind: "physics.field-drive",
          nodeId,
          type: "physics-field-drive",
        },
      });
    },
    [],
  );

  const handleToggleDrive = useCallback(
    async (row: FieldDriveSummaryRow, enabled: boolean) => {
      if (row.driveKind === "regional" && row.regionalDrive) {
        const res = await kernel.api.model.replaceFieldDrive(row.id, {
          base_revision: scene.data?.revision ?? null,
          drive: { ...row.regionalDrive, enabled },
        });
        publishCommittedSceneResource(kernel.resources, res.committed_scene, res.scene_revision);
        kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, res.scene_revision);
      } else if (row.driveKind === "mask" && row.maskDrive) {
        const res = await kernel.api.model.replaceMaskFieldDrive(row.id, {
          base_revision: scene.data?.revision ?? null,
          drive: { ...row.maskDrive, enabled },
        });
        publishCommittedSceneResource(kernel.resources, res.committed_scene, res.scene_revision);
        kernel.resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, res.scene_revision);
      }
    },
    [kernel.api.model, kernel.resources, scene.data?.revision],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const row = pendingDelete;
    setPendingDelete(null);
    if (row.driveKind === "regional") {
      const res = await kernel.api.model.deleteFieldDrive(row.id, {
        base_revision: scene.data?.revision ?? null,
      });
      publishCommittedSceneResource(kernel.resources, res.committed_scene, res.scene_revision);
      kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, res.scene_revision);
    } else {
      const res = await kernel.api.model.deleteMaskFieldDrive(row.id, {
        base_revision: scene.data?.revision ?? null,
      });
      publishCommittedSceneResource(kernel.resources, res.committed_scene, res.scene_revision);
      kernel.resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, res.scene_revision);
    }
  }, [kernel.api.model, kernel.resources, pendingDelete, scene.data?.revision]);

  const spec = useMemo<InspectorSpec<FieldDrivesRootDraft>>(
    () => ({
      id: "physics.field-drives-root",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          {
            id: "global",
            label: "Global Physics",
            selection: buildRootSelection(
              "physics.scope.global",
              "model:physics:global",
              "Global Physics",
            ),
          },
          { id: "field-drives", label: "Field Drives" },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: Radio,
        title: () => "Field Drives",
        kindLabel: "Prescribed magnetic field excitations",
        entityId: "model:physics:field-drives",
        statePill: (draft) => ({
          tone: draft.rows.length > 0 ? "ok" : "neutral",
          label: `${draft.rows.length} drives`,
        }),
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "total", label: "Total drives", value: String(draft.rows.length) },
        {
          id: "active",
          label: "Enabled",
          value: String(draft.rows.filter((r) => r.enabled).length),
        },
      ],
      sections: [
        {
          id: "field-drives-create",
          title: "Add excitation drive",
          icon: Plus,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              wide: true,
              render: (ctx) => (
                <div className="grid grid-cols-2 gap-1.5" data-slot="field-drive-starters">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      openNewDriveDraft(
                        "regional",
                        "New Sinc Pulse Drive",
                        ctx.selectNode,
                        "sinc_pulse",
                      )
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Sinc Pulse</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      openNewDriveDraft(
                        "regional",
                        "New Harmonic Drive",
                        ctx.selectNode,
                        "sinusoidal",
                      )
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Harmonic RF</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      openNewDriveDraft(
                        "regional",
                        "New Gaussian Pulse",
                        ctx.selectNode,
                        "gaussian_pulse",
                      )
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Gaussian Pulse</span>
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      openNewDriveDraft("mask", "New Mask Field Drive", ctx.selectNode)
                    }
                  >
                    <Plus aria-hidden="true" size={12} />
                    <span>Mask Antenna</span>
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "field-drives-table",
          title: "Configured field drives",
          icon: Waves,
          defaultOpen: true,
          emptyState: (d) =>
            d.rows.length === 0
              ? {
                  icon: Waves,
                  title: "No field drives configured",
                  description:
                    "Create a regional or mask magnetic field drive to excite FMR, spin-wave dispersion, or switching dynamics.",
                }
              : null,
          rows: [
            {
              type: "table",
              wide: true,
              showWhen: (d) => d.rows.length > 0,
              rowKey: (rawRow) => {
                const row = rawRow as FieldDriveSummaryRow;
                return `${row.driveKind}:${row.id}`;
              },
              rows: (d) => d.rows,
              onSelectRow: (rawRow, ctx) => {
                const row = rawRow as FieldDriveSummaryRow;
                const nodeId = `model:physics:field-drives:${row.id}`;
                ctx.selectNode({
                  kind: "physics.field-drive",
                  label: row.label,
                  nodeId,
                  objectId: null,
                  ref: {
                    fieldDriveId: row.id,
                    ...(row.driveKind === "mask" ? { fieldDriveKind: "mask" as const } : {}),
                    kind: "physics.field-drive",
                    nodeId,
                    type: "physics-field-drive",
                  },
                });
              },
              columns: [
                {
                  id: "label",
                  header: "Drive",
                  renderCell: (rawRow) => {
                    const row = rawRow as FieldDriveSummaryRow;
                    return (
                      <div className="flex flex-col">
                        <span className="font-medium text-[var(--fm-text)]">{row.label}</span>
                        <span className="text-xs text-[var(--fm-text-muted)]">
                          {row.waveformLabel} · {row.targetLabel}
                        </span>
                      </div>
                    );
                  },
                },
                {
                  id: "kind",
                  header: "Family",
                  renderCell: (rawRow) =>
                    (rawRow as FieldDriveSummaryRow).driveKind === "mask" ? "Mask" : "Regional",
                },
                {
                  id: "actions",
                  header: "Active",
                  align: "right",
                  renderCell: (rawRow) => {
                    const row = rawRow as FieldDriveSummaryRow;
                    return (
                      <div className="flex items-center justify-end gap-1.5">
                        <Switch
                          aria-label={`Toggle ${row.label}`}
                          checked={row.enabled}
                          onCheckedChange={(checked) => {
                            void handleToggleDrive(row, checked);
                          }}
                        />
                        <Button
                          aria-label={`Delete ${row.label}`}
                          size="icon"
                          type="button"
                          variant="ghost"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete(row);
                          }}
                        >
                          <Trash2 aria-hidden="true" size={13} />
                        </Button>
                      </div>
                    );
                  },
                },
              ],
            },
          ],
        },
      ],
      commitBar: {
        mode: "immediate",
        statusMessage: () =>
          "Select a field drive to inspect its B(t) waveform, spectrum, and spatial mask",
      },
    }),
    [handleToggleDrive, openNewDriveDraft],
  );

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete field drive &ldquo;{pendingDelete?.label ?? ""}&rdquo;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the prescribed magnetic field drive from the session model.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirmDelete()}>
              Delete field drive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SpecInspectorHost>
  );
}

/* ── 9. UnresolvedPhysicsScopeInspectorPanel (`physics.scope.unresolved`) ── */

interface UnresolvedItem {
  id: string;
  kind: string;
  reason: string;
}

interface UnresolvedPhysicsDraft {
  targetObjectId: string;
  items: readonly UnresolvedItem[];
  graphStatus: string;
}

export function UnresolvedPhysicsScopeInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const scene = useSceneResource();
  const physicsGraph = usePhysicsGraphResource();
  const fieldDrivesRes = useFieldDrivesResource();
  const maskDrivesRes = useMaskFieldDrivesResource();
  const couplingsRes = useModelCouplingsResource();
  const frozenSpinsRes = useFrozenSpinsCollectionResource({ enabled: true });
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const objects = useMemo(
    () => (scene.data?.objects ?? []).filter((o) => !isAirboxSceneObject(o)),
    [scene.data?.objects],
  );
  const objectIds = useMemo(() => new Set(objects.map((o) => o.id)), [objects]);

  const unresolvedItems = useMemo<readonly UnresolvedItem[]>(() => {
    const g = (physicsGraph.data ?? null) as Record<string, unknown> | null;
    const mods = Array.isArray(g?.modules) ? (g.modules as Record<string, unknown>[]) : [];
    const found: UnresolvedItem[] = [];
    for (const mod of mods) {
      const id = String(mod.id ?? "");
      const kind = String(mod.kind ?? "module");
      const scopes = Array.isArray(mod.applies_to)
        ? (mod.applies_to as Record<string, unknown>[])
        : [];
      if (scopes.length === 0) {
        found.push({ id, kind, reason: "Module has no target scope assigned." });
        continue;
      }
      for (const sc of scopes) {
        if (sc.kind === "unresolved") {
          found.push({
            id,
            kind,
            reason: String(sc.reason ?? "Target scope could not be resolved."),
          });
        } else if (
          (sc.kind === "object" || sc.kind === "region") &&
          typeof sc.object_id === "string" &&
          objects.length > 0 &&
          !objectIds.has(sc.object_id)
        ) {
          found.push({
            id,
            kind,
            reason: `Target object "${sc.object_id}" is absent from the scene.`,
          });
        }
      }
    }
    return found;
  }, [objectIds, objects.length, physicsGraph.data]);

  const baseline = useMemo<UnresolvedPhysicsDraft>(
    () => ({
      targetObjectId: objects[0]?.id ?? "",
      items: unresolvedItems,
      graphStatus: physicsGraph.status,
    }),
    [objects, physicsGraph.status, unresolvedItems],
  );

  const objectOptions = useMemo(
    () =>
      objects.map((obj) => ({
        value: obj.id,
        label: `${obj.name ?? obj.id} (${obj.id})`,
      })),
    [objects],
  );

  const handleDeleteOrphanDrives = useCallback(async () => {
    setConfirmClearOpen(false);
    const { context } = buildModelScopeMutationContext(
      kernel,
      scene.data,
      scene.sessionScopeKey,
    );
    await runAuthoringMutationWithHistory(
      context,
      "Delete orphaned physics modules",
      async ({ baseRevision: capturedRev }) => {
        let rev = capturedRev ?? scene.data?.revision ?? null;
        for (const item of unresolvedItems) {
          if (item.kind === "regional_field_drive") {
            const res = await kernel.api.model
              .deleteFieldDrive(item.id, { base_revision: rev })
              .catch(() => null);
            if (res && typeof res.scene_revision === "number") rev = res.scene_revision;
          } else if (item.kind === "mask_field_drive") {
            const res = await kernel.api.model
              .deleteMaskFieldDrive(item.id, { base_revision: rev })
              .catch(() => null);
            if (res && typeof res.scene_revision === "number") rev = res.scene_revision;
          } else if (item.kind === "coupling") {
            const res = await kernel.api.model
              .deleteCoupling(item.id, { baseRevision: rev ?? undefined })
              .catch(() => null);
            if (res && typeof res.scene_revision === "number") rev = res.scene_revision;
          } else if (item.kind === "frozen_spins" || item.kind === "magnetization_constraint") {
            await kernel.api.model.frozenSpins
              .delete?.(item.id, {
                expected_revision: frozenSpinsRes.data?.revision ?? rev ?? 0,
              })
              ?.catch(() => null);
          }
        }
        return rev;
      },
    );
    const rev = fallbackRevision(null);
    kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
    kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, rev);
    kernel.resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, rev);
    kernel.resources.invalidate(MODEL_COUPLINGS_PATH, rev);
    kernel.resources.invalidate(MODEL_FROZEN_SPINS_PATH, rev);
    kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
  }, [
    frozenSpinsRes.data?.revision,
    kernel,
    scene.data,
    scene.sessionScopeKey,
    unresolvedItems,
  ]);

  const spec = useMemo<InspectorSpec<UnresolvedPhysicsDraft>>(
    () => ({
      id: "physics.scope.unresolved",
      header: {
        breadcrumbs: [
          {
            id: "session",
            label: "Session Model",
            selection: buildRootSelection("session.root", "model:session", "Session Model"),
          },
          { id: "unresolved", label: "Unresolved Physics" },
        ],
        searchable: false,
      },
      identity: {
        domain: "physics",
        icon: AlertTriangle,
        title: () => "Unresolved Physics",
        kindLabel: "Diagnostic scope recovery",
        entityId: "model:physics:unresolved",
        statePill: (draft) =>
          draft.items.length > 0
            ? { tone: "err", label: `${draft.items.length} unresolved` }
            : draft.graphStatus === "loading"
              ? { tone: "info", label: "Loading graph" }
              : { tone: "warn", label: "Graph diagnostic" },
      },
      facts: (draft): readonly InspectorFact[] => [
        { id: "count", label: "Orphaned modules", value: String(draft.items.length), tone: "err" },
        { id: "objects", label: "Candidate targets", value: String(objectOptions.length) },
      ],
      notices: (draft): readonly InspectorNotice<UnresolvedPhysicsDraft>[] =>
        draft.items.length > 0
          ? draft.items.map((item) => ({
              id: `unresolved-${item.id}`,
              tone: "err",
              title: `${item.kind} \u00b7 ${item.id}`,
              text: item.reason,
            }))
          : [
              {
                id: "physics-graph-refresh",
                tone: "warn",
                title: "Physics graph synchronization",
                text: "Refresh the canonical physics graph resource or inspect object-level physics switches.",
                quickFix: {
                  label: "Refresh physics graph",
                  onApply: () => {
                    kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, fallbackRevision(null));
                  },
                },
              },
            ],
      sections: [
        {
          id: "unresolved-repair",
          title: "Rebind or remove orphaned modules",
          icon: AlertTriangle,
          defaultOpen: true,
          rows: [
            {
              key: "targetObjectId",
              type: "select",
              label: "Replacement target object",
              options:
                objectOptions.length > 0
                  ? objectOptions
                  : [
                      {
                        value: "",
                        label: "No scene objects available",
                        disabledReason: "Create a scene object first.",
                      },
                    ],
              disabledReason: () =>
                objectOptions.length === 0
                  ? "Create a scene object before rebinding orphaned physics modules."
                  : null,
            },
          ],
          footer: () => (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                onClick={() =>
                  kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, fallbackRevision(null))
                }
              >
                Refresh Graph
              </Button>
              {unresolvedItems.length > 0 ? (
                <Button
                  size="sm"
                  type="button"
                  variant="danger"
                  onClick={() => setConfirmClearOpen(true)}
                >
                  <Trash2 aria-hidden="true" size={12} />
                  <span>Delete Orphaned Modules</span>
                </Button>
              ) : null}
            </div>
          ),
        },
      ],
      commitBar: {
        mode: "staged",
        allowCleanApply: (draft) => Boolean(draft.targetObjectId) && draft.items.length > 0,
        applyLabel: "Rebind Orphaned Modules",
        cleanMessage: () => "Choose a replacement object to rebind unresolved modules",
        lockReason: (draft) =>
          !draft.targetObjectId
            ? "Select a valid target object to rebind."
            : draft.items.length === 0
              ? "No unresolved physics modules require rebinding."
              : null,
        onApply: async (draft) => {
          if (!draft.targetObjectId || draft.items.length === 0) return false;
          const { context } = buildModelScopeMutationContext(
            kernel,
            scene.data,
            scene.sessionScopeKey,
          );
          const reqOptions = scene.sessionScopeKey
            ? { sessionScopeKey: scene.sessionScopeKey }
            : undefined;

          const cachedRegional = extractFieldDriveItems(fieldDrivesRes.data);
          const sceneRegional = extractFieldDriveItems(scene.data?.field_drives);
          const cachedMask = extractFieldDriveItems(maskDrivesRes.data);
          const sceneMask = Array.isArray(
            (scene.data?.field_drives as Record<string, unknown> | undefined)?.mask_drives,
          )
            ? ((scene.data!.field_drives as Record<string, unknown>).mask_drives as Record<
                string,
                unknown
              >[])
            : [];
          const cachedCouplings =
            (couplingsRes.data as { couplings?: unknown[]; items?: unknown[] } | null)
              ?.couplings ??
            (couplingsRes.data as { items?: unknown[] } | null)?.items ??
            scene.data?.couplings ??
            [];

          let latestRev: number | null = scene.data?.revision ?? null;

          await runAuthoringMutationWithHistory(
            context,
            `Rebind unresolved physics to ${draft.targetObjectId}`,
            async ({ baseRevision: capturedRev }) => {
              latestRev = capturedRev ?? latestRev;
              const mergePatch: Record<string, unknown> = {};

              for (const item of draft.items) {
                if (item.kind === "regional_field_drive") {
                  let found =
                    cachedRegional.find((d) => String(d.id ?? "") === item.id) ??
                    sceneRegional.find((d) => String(d.id ?? "") === item.id);
                  if (!found && typeof kernel.api.model.fieldDrives === "function") {
                    const listRes = await kernel.api.model.fieldDrives().catch(() => null);
                    found = (listRes?.drives?.find((d) => d.id === item.id) ?? undefined) as
                      | Record<string, unknown>
                      | undefined;
                  }
                  if (found) {
                    const payload = {
                      base_revision: latestRev,
                      drive: {
                        ...(found as unknown as RegionalFieldDriveResource),
                        target: { kind: "object" as const, object_id: draft.targetObjectId },
                      },
                    };
                    const res = reqOptions
                      ? await kernel.api.model.replaceFieldDrive(item.id, payload, reqOptions)
                      : await kernel.api.model.replaceFieldDrive(item.id, payload);
                    latestRev = res.scene_revision;
                    publishCommittedSceneResource(
                      kernel.resources,
                      res.committed_scene,
                      res.scene_revision,
                    );
                  }
                } else if (item.kind === "mask_field_drive") {
                  let found =
                    cachedMask.find((d) => String(d.id ?? "") === item.id) ??
                    sceneMask.find((d) => String(d.id ?? "") === item.id);
                  const modelRec = kernel.api.model as unknown as Record<string, unknown>;
                  if (!found && typeof modelRec.maskFieldDrives === "function") {
                    const listRes = (await (
                      modelRec.maskFieldDrives as () => Promise<{
                        drives?: Record<string, unknown>[];
                        items?: Record<string, unknown>[];
                      }>
                    )().catch(() => null));
                    found = (listRes?.drives ?? listRes?.items ?? []).find(
                      (d) => String(d.id ?? "") === item.id,
                    );
                  }
                  if (found) {
                    const payload = {
                      base_revision: latestRev,
                      drive: {
                        ...(found as unknown as MaskFieldDriveResource),
                        target: { kind: "object" as const, object_id: draft.targetObjectId },
                      },
                    };
                    const res = reqOptions
                      ? await kernel.api.model.replaceMaskFieldDrive(item.id, payload, reqOptions)
                      : await kernel.api.model.replaceMaskFieldDrive(item.id, payload);
                    latestRev = res.scene_revision;
                    publishCommittedSceneResource(
                      kernel.resources,
                      res.committed_scene,
                      res.scene_revision,
                    );
                  }
                } else if (item.kind === "coupling") {
                  const found = cachedCouplings.find((entry) => {
                    const rec = entry as Record<string, unknown>;
                    return String(rec.coupling_id ?? rec.id ?? "") === item.id;
                  }) as Record<string, unknown> | undefined;
                  const epA = (found?.source ?? found?.endpoint_a ?? null) as Record<
                    string,
                    unknown
                  > | null;
                  const epB = (found?.target ?? found?.endpoint_b ?? null) as Record<
                    string,
                    unknown
                  > | null;
                  const aId = String(epA?.object ?? epA?.object_id ?? "");
                  const bId = String(epB?.object ?? epB?.object_id ?? "");
                  const aMissing = !aId || !objectIds.has(aId);
                  const bMissing = !bId || !objectIds.has(bId);
                  const couplingPatch: SceneCouplingPatch = {
                    ...(aMissing || (!aMissing && !bMissing)
                      ? { source: { kind: "object", object: draft.targetObjectId } }
                      : {}),
                    ...(bMissing
                      ? { target: { kind: "object", object: draft.targetObjectId } }
                      : {}),
                  };
                  const res = await kernel.api.model.patchCoupling(item.id, couplingPatch, {
                    baseRevision: latestRev ?? undefined,
                    ...(reqOptions ?? {}),
                  });
                  latestRev = res.scene_revision;
                  publishCommittedSceneResource(
                    kernel.resources,
                    res.committed_scene,
                    res.scene_revision,
                  );
                } else if (
                  item.kind === "frozen_spins" ||
                  item.kind === "magnetization_constraint"
                ) {
                  const found = (frozenSpinsRes.data?.definitions ?? []).find(
                    (d) => d.id === item.id,
                  );
                  if (found) {
                    const payload = {
                      expected_revision: frozenSpinsRes.data?.revision ?? latestRev ?? 0,
                      definition: {
                        ...found,
                        selector: { kind: "in_object" as const, object_id: draft.targetObjectId },
                      },
                    };
                    if (reqOptions) {
                      await kernel.api.model.frozenSpins.patch(item.id, payload, reqOptions);
                    } else {
                      await kernel.api.model.frozenSpins.patch(item.id, payload);
                    }
                  }
                } else {
                  const collectionKey =
                    item.kind === "spin_torque"
                      ? "spin_torques"
                      : item.kind === "oersted_field"
                        ? "oersted_fields"
                        : item.kind === "current_transport"
                          ? "current_transports"
                          : item.kind === "spin_transport"
                            ? "spin_transports"
                            : null;
                  if (collectionKey && scene.data) {
                    const sceneRec = scene.data as unknown as Record<string, unknown>;
                    const list = Array.isArray(sceneRec[collectionKey])
                      ? (sceneRec[collectionKey] as Record<string, unknown>[])
                      : [];
                    if (list.some((entry) => String(entry.id ?? "") === item.id)) {
                      mergePatch[collectionKey] = list.map((entry) =>
                        String(entry.id ?? "") === item.id
                          ? { ...entry, object_id: draft.targetObjectId }
                          : entry,
                      );
                    }
                  }
                }
              }

              if (Object.keys(mergePatch).length > 0) {
                const payload = {
                  kind: "merge_patch" as const,
                  base_revision: latestRev ?? 0,
                  merge_patch: mergePatch as JsonObject,
                };
                const tx = reqOptions
                  ? await kernel.api.model.commitTransaction(payload, reqOptions)
                  : await kernel.api.model.commitTransaction(payload);
                latestRev = tx.scene_revision;
                publishCommittedSceneResource(
                  kernel.resources,
                  tx.committed_scene,
                  tx.scene_revision,
                );
              }
              return latestRev;
            },
          );

          const rev = fallbackRevision(latestRev);
          kernel.resources.invalidate(MODEL_PHYSICS_GRAPH_PATH, rev);
          kernel.resources.invalidate(MODEL_FIELD_DRIVES_PATH, rev);
          kernel.resources.invalidate(MODEL_MASK_FIELD_DRIVES_PATH, rev);
          kernel.resources.invalidate(MODEL_COUPLINGS_PATH, rev);
          kernel.resources.invalidate(MODEL_FROZEN_SPINS_PATH, rev);
          kernel.resources.invalidate(MODEL_SCENE_PATH, rev);
          return true;
        },
      },
    }),
    [
      couplingsRes.data,
      fieldDrivesRes.data,
      frozenSpinsRes.data?.definitions,
      frozenSpinsRes.data?.revision,
      kernel,
      maskDrivesRes.data,
      objectIds,
      objectOptions,
      scene.data,
      scene.sessionScopeKey,
      unresolvedItems.length,
    ],
  );

  return (
    <SpecInspectorHost baseline={baseline} selection={selection} spec={spec}>
      <AlertDialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete orphaned physics modules?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes unresolved physics modules whose target object was deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDeleteOrphanDrives()}>
              Delete modules
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SpecInspectorHost>
  );
}
