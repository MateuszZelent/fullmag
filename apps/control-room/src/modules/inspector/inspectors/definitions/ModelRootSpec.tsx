"use client";

import {
  Box,
  FolderKanban,
  Globe,
  Layers,
  Link2,
  Maximize2,
  Plus,
  Shield,
  Sliders,
  Waves,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  MODEL_READINESS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
  MODEL_UNIVERSE_FIT_PATH,
  MODEL_UNIVERSE_PATH,
} from "@/kernel/api/apiPaths";
import { runAuthoringMutationWithHistory } from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  MESH_SUMMARY_RESOURCE_KEY,
  publishCommittedSceneResource,
  useMeshSummaryResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { useModelReadinessResource } from "@/kernel/resources/studyRuntimeResources";
import { useActiveLaneCapabilities } from "@/kernel/resources/useActiveLaneCapabilities";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type {
  InspectorFact,
  InspectorNotice,
  InspectorSpec,
} from "../../template";
import {
  resolveAirboxInspectorAuthoringLane,
  resolveAirboxInspectorLane,
  useAirboxInspectorRuntimeStatus,
} from "../../panels/airbox/airboxInspectorRuntimeStatus";
import { navigateToStudyRoot } from "../../panels/airbox/airboxNavigation";
import {
  buildBuilderPrimitiveSelection,
  buildObjectSelection,
  buildRootSelection,
  fallbackRevision,
  formatSpanAuto,
  InspectorShortcutCards,
  SpecInspectorHost,
  type InspectorShortcutCardItem,
} from "../../panels/model-roots/SpecInspectorHost";
import {
  isAirboxSceneObject,
  buildModelScopeMutationContext,
  computeSceneObjectsAabb,
} from "./modelScopeShared";

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
