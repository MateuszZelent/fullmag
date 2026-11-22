"use client";

import {
  Activity,
  ArrowRightLeft,
  Bug,
  Clipboard,
  Eye,
  Layers,
  Palette,
  Play,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import type {
  MeshSharedDomainManifestResource,
  VisualizationStatePatch,
  VisualizationStateResource,
} from "@/kernel/api/apiTypes";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { CommandId } from "@/kernel/commands/commandTypes";
import { KernelContext, useKernel } from "@/kernel/KernelContext";
import {
  useMeshSharedDomainManifestResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { visualizationSceneObjectIds } from "@/kernel/selection/visualizationTargetResolver";
import type { KernelApi } from "@/kernel/types";
import {
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  hasVisualizationStatePatch,
  mergeVisualizationStateTargetOverride,
  persistentVisualizationTargetPatch,
  resetAirboxVisualizationState,
  resolveTargetVisualization,
  resolveVisualizationTargetFromSelection,
  visualizationTargetKey,
  type ObjectVisualizationController,
  type VisualizationTargetPatch,
  type VisualizationTargetRef,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  useObjectVisualizationController,
  useObjectVisualizationSelector,
} from "@/kernel/visualization/useObjectVisualization";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { EmptyState } from "@/shared/ui/EmptyState";
import { Slider } from "@/shared/ui/Slider";
import { Switch } from "@/shared/ui/Switch";

import {
  InspectorEditSessionProvider,
  useInspectorEditSession,
  useInspectorEditSessionStore,
} from "../../InspectorEditSession";
import { inspectorFitCommandId } from "../../inspectorFitCommand";
import type { InspectorPanelProps } from "../../inspectorTypes";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import {
  InspectorTemplate,
  type InspectorFact,
  type InspectorSpec,
  type InspectorTone,
} from "../../template";
import { AirboxVisualizationDebugContent } from "../airbox/AirboxVisualizationDebugInspectorPanel";
import { AirboxVisualizationPanel } from "../airbox/AirboxVisualizationPanel";
import { EigenModesVisualizationInspectorPanel } from "../../inspectors/results/frequency-domain";
import { MeshPartVisualizationPanel } from "../MeshPartVisualizationPanel";
import { ModeVisualizationOverviewPanel } from "../mode-visualization/ModeVisualizationOverviewPanel";
import { ObjectVisualizationPanel as ObjectVisualizationEntryPanel } from "../ObjectVisualizationEntryPanel";
import {
  ObjectVisualizationPanel,
  type VisualizationInspectorOwner,
} from "../ObjectVisualizationPanel";
import {
  queuePartVectorVisibilityPatch,
  resolveObjectVisualizationPanelTarget,
  resolveSelectedTargetVectorMeshPartRows,
  scalarColorPalettePatch,
  visualizationOverridesForTargetReset,
} from "../ObjectVisualizationPanelModel";
import {
  ANGLE_RAD_UNITS_SI,
  ConnectedInspectorSpec,
} from "../study/ConnectedInspectorSpec";
import { VisualizationDebugPanel } from "../visualization-debug/VisualizationDebugPanel";
import { buildVisualizationDebugExport } from "../visualization-debug/visualizationDebugExport";
import type { VisualizationDebugPanelModel } from "../visualization-debug/VisualizationDebugPanelModel";
import {
  allIssues,
  allObservations,
  formatBytes,
  memoryGroups,
  uniqueSnapshots,
  visualizationDebugEmptyStateMessage,
} from "../visualization-debug/visualizationDebugPresentation";

export interface SurfacePartVectorRow {
  readonly id: string;
  readonly label: string;
  readonly vectorsVisible: boolean;
}

export function toggleObjectSurfacePartVectors({
  controller,
  meshParts,
  partId,
  sceneObjectIds,
  state,
  sync,
  visible,
}: {
  controller: Pick<ObjectVisualizationController, "patchTargetPending">;
  meshParts: NonNullable<MeshSharedDomainManifestResource["mesh_parts"]>;
  partId: string;
  sceneObjectIds: ReadonlySet<string>;
  state: VisualizationStateResource;
  sync: Pick<
    { queuePatch: (patch: VisualizationStatePatch) => { transactionId: string } },
    "queuePatch"
  >;
  visible: boolean;
}): VisualizationTargetRef | null {
  const matched = meshParts.find((part) => part.id === partId);
  if (!matched) return null;
  return queuePartVectorVisibilityPatch({
    controller,
    part: matched,
    sceneObjectIds,
    state,
    sync,
    visible,
  });
}

const readKernelHook: () => KernelApi = useKernel;

function readFallbackMockedKernel(): KernelApi | null {
  try {
    return readKernelHook();
  } catch {
    return null;
  }
}

function useOptionalKernel(): KernelApi | null {
  const contextKernel = useContext(KernelContext);
  return contextKernel ?? readFallbackMockedKernel();
}

function hasFullVisualizationKernel(kernel: KernelApi | null): kernel is KernelApi {
  return Boolean(
    kernel &&
      kernel.visualizationDebug &&
      typeof kernel.visualizationSync?.subscribe === "function",
  );
}

interface HostedEmptyDraft {
  readonly __hosted: true;
  readonly __hosted_workspace?: null;
}

const HOSTED_EMPTY_DRAFT: HostedEmptyDraft = Object.freeze({ __hosted: true });
const EMPTY_DIRTY_SET: ReadonlySet<string> = new Set();
const EMPTY_INVALID_MAP: ReadonlyMap<string, string> = new Map();

function OptionalEditSessionScope({ children }: { children: ReactNode }) {
  const existingStore = useInspectorEditSessionStore();
  if (existingStore) return <>{children}</>;
  return <InspectorEditSessionProvider>{children}</InspectorEditSessionProvider>;
}

function HostedVisualizationTemplateInner({
  breadcrumbs,
  canFitView = true,
  children,
  commitMode,
  entityId,
  facts = [],
  icon,
  kindLabel,
  onExtraReset,
  ownerId,
  sectionTitle,
  selection,
  statePill,
  title,
}: {
  breadcrumbs: readonly string[];
  canFitView?: boolean;
  children: ReactNode;
  commitMode: "liveViewport" | "readOnly";
  entityId?: string;
  facts?: readonly InspectorFact[];
  icon: LucideIcon;
  kindLabel: string;
  onExtraReset?: () => void;
  ownerId: string;
  sectionTitle: string;
  selection: InspectorPanelProps["selection"];
  statePill: { tone: InspectorTone; label: string };
  title: string;
}) {
  const kernel = useOptionalKernel();
  const editSession = useInspectorEditSession();
  const [codePreview, setCodePreview] = useState<{
    title: string;
    code: string;
  } | null>(null);

  const hasLiveOverrides = Boolean(
    commitMode === "liveViewport" && editSession?.dirty,
  );

  const handleResetDisplay = useCallback(async () => {
    await editSession?.reset();
    onExtraReset?.();
  }, [editSession, onExtraReset]);

  const handleSelectNode = useCallback(
    (next: Omit<InspectorPanelProps["selection"], "moduleSource">) => {
      kernel?.selection?.set?.(next, "inspector");
    },
    [kernel],
  );

  const handleFitView = useCallback(
    (commandId?: CommandId) => {
      if (!kernel?.commands?.execute) return;
      const activeMain = kernel.layout?.get?.().activeViewportMainModuleId ?? "viewport-3d";
      const resolvedId = commandId ?? inspectorFitCommandId(activeMain);
      void kernel.commands.execute(
        resolvedId,
        createCommandContext("inspector", kernel),
      );
    },
    [kernel],
  );

  const handleHideInspector = useCallback(() => {
    if (!kernel?.commands?.execute) return;
    void kernel.commands.execute(
      "panels:inspector:toggle",
      createCommandContext("inspector", kernel),
    );
  }, [kernel]);

  const spec = useMemo<InspectorSpec<HostedEmptyDraft>>(
    () => ({
      id: ownerId,
      header: {
        breadcrumbs: breadcrumbs.map((label, idx) => ({
          id: `crumb-${idx}`,
          label,
        })),
        canFitView,
        searchable: false,
      },
      identity: {
        domain: "visualization",
        icon,
        title: () => title,
        kindLabel,
        entityId,
        statePill: () => statePill,
      },
      facts: () => facts,
      sections: [
        {
          id: "visualization-workspace",
          title: sectionTitle,
          icon,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              key: "__hosted_workspace",
              label: "",
              wide: true,
              render: () => children,
            },
          ],
        },
      ],
      commitBar:
        commitMode === "liveViewport"
          ? {
              mode: "liveViewport",
              hasOverrides: () => hasLiveOverrides,
              onResetDisplay: handleResetDisplay,
            }
          : {
              mode: "readOnly",
              statusMessage: () => "Diagnostic · Bounded viewport & carrier evidence",
            },
    }),
    [
      breadcrumbs,
      canFitView,
      children,
      commitMode,
      entityId,
      facts,
      handleResetDisplay,
      hasLiveOverrides,
      icon,
      kindLabel,
      ownerId,
      sectionTitle,
      statePill,
      title,
    ],
  );

  return (
    <>
      <InspectorTemplate
        baseline={HOSTED_EMPTY_DRAFT}
        dirtyFields={EMPTY_DIRTY_SET}
        draft={HOSTED_EMPTY_DRAFT}
        invalidFields={EMPTY_INVALID_MAP}
        selection={selection}
        spec={spec}
        touchedFields={EMPTY_DIRTY_SET}
        onFieldChange={() => undefined}
        onFieldTouch={() => undefined}
        onFitView={handleFitView}
        onHideInspector={handleHideInspector}
        onOpenCodePreview={(previewTitle, _language, code) =>
          setCodePreview({ title: previewTitle, code })
        }
        onResetDisplay={handleResetDisplay}
        onRevertField={() => undefined}
        onSelectNode={handleSelectNode}
      />
      <Dialog
        open={codePreview !== null}
        onOpenChange={(open) => {
          if (!open) setCodePreview(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{codePreview?.title ?? "Python DSL"}</DialogTitle>
            <DialogDescription>
              Equivalent Fullmag Python authoring snippet for the current selection.
            </DialogDescription>
          </DialogHeader>
          <pre className="fm-inspector-code-preview">
            <code>{codePreview?.code ?? ""}</code>
          </pre>
        </DialogContent>
      </Dialog>
    </>
  );
}

function HostedVisualizationTemplateShell(
  props: Parameters<typeof HostedVisualizationTemplateInner>[0],
) {
  return (
    <OptionalEditSessionScope>
      <HostedVisualizationTemplateInner {...props} />
    </OptionalEditSessionScope>
  );
}

const OBJECT_REGION_VISUALIZATION_OWNER: VisualizationInspectorOwner = {
  actionSummary: "Region visibility, surface coloring, vectors, wireframe, and overrides",
  capabilityDescription:
    "Uses the canonical object-region target and inherits parent object defaults unless overridden.",
  id: "object.region.visualization",
  targetLabel: "Object region",
  title: "Region visualization",
};

interface VisualizationDebugOwnerContract {
  readonly actionSummary: string;
  readonly capabilityDescription: string;
  readonly id: string;
  readonly targetLabel: string;
  readonly title: string;
}

const OBJECT_VISUALIZATION_DEBUG_OWNER: VisualizationDebugOwnerContract = {
  actionSummary: "Inspect object render adoption and export bounded evidence",
  capabilityDescription:
    "Object-scoped FEM viewport snapshots, field carriers, and exact transport metadata",
  id: "object.visualization.debug",
  targetLabel: "Object target",
  title: "Object Visualization Debug",
};

const OBJECT_REGION_VISUALIZATION_DEBUG_OWNER: VisualizationDebugOwnerContract = {
  actionSummary: "Inspect region overlay adoption and export bounded evidence",
  capabilityDescription:
    "Region overlay snapshots with part-scoped carriers and exact transport metadata",
  id: "object.region.visualization.debug",
  targetLabel: "Object region target",
  title: "Region Visualization Debug",
};

const MESH_PART_VISUALIZATION_DEBUG_OWNER: VisualizationDebugOwnerContract = {
  actionSummary: "Inspect mesh-part carrier adoption and export bounded evidence",
  capabilityDescription:
    "Part-scoped viewport snapshots, field carriers, and exact transport metadata",
  id: "mesh.part.visualization.debug",
  targetLabel: "Mesh part target",
  title: "Mesh Part Visualization Debug",
};

function resolveDebugTargetId(selection: InspectorPanelProps["selection"]): string {
  const ref = selection.ref;
  if (ref && "visualizationTargetId" in ref) {
    return String(ref.visualizationTargetId);
  }
  return selection.nodeId ?? "target";
}

function VisualizationDebugOwnerBody({
  owner,
  selection,
}: InspectorPanelProps & { owner: VisualizationDebugOwnerContract }) {
  const targetId = resolveDebugTargetId(selection);
  return (
    <div className="fm-inspector-panel" data-inspector-owner={owner.id}>
      <InspectorGroup title={owner.title}>
        <FieldRow label="Owner" value={owner.id} />
        <FieldRow label="Target" value={`${owner.targetLabel} (${targetId})`} />
        <FieldRow label="Capabilities" value={owner.capabilityDescription} />
        <FieldRow label="Actions" value={owner.actionSummary} />
      </InspectorGroup>
      <VisualizationDebugPanel selection={selection} />
    </div>
  );
}

// ============================================================================
// Standalone / minimal-mock fallback spec (for isolated unit tests without full KernelApi)
// ============================================================================

interface TargetVisualizationDraft {
  visible: boolean;
  renderMode: string;
  surfaceQuantity: string;
  palette: string;
  vectorsVisible: boolean;
  vectorBudget: number;
  opacityPercent: number;
  phaseDeg: number;
}

const DEFAULT_VIZ_DRAFT: TargetVisualizationDraft = {
  visible: true,
  renderMode: "surface",
  surfaceQuantity: "m",
  palette: "viridis",
  vectorsVisible: true,
  vectorBudget: 2500,
  opacityPercent: 100,
  phaseDeg: 0,
};

function buildTargetVisualizationSpec({
  breadcrumbs,
  idPrefix,
  kindLabel,
  onResetDisplay,
  onToggleSurfaceVectors,
  selection,
  surfaces,
  titleFallback,
}: {
  breadcrumbs: readonly string[];
  idPrefix: string;
  kindLabel: string;
  onResetDisplay: () => void;
  onToggleSurfaceVectors?: (partId: string, visible: boolean) => void;
  selection: InspectorPanelProps["selection"];
  surfaces?: readonly SurfacePartVectorRow[];
  titleFallback: string;
}): InspectorSpec<TargetVisualizationDraft> {
  return {
    id: idPrefix,
    header: {
      breadcrumbs: breadcrumbs.map((b, i) => ({ id: `b-${i}`, label: b })),
      canFitView: true,
      searchable: true,
    },
    identity: {
      domain: "visualization",
      icon: Eye,
      title: () => selection.label || titleFallback,
      kindLabel,
      entityId: selection.objectId ?? selection.nodeId ?? undefined,
      statePill: (d) => ({
        tone: d.visible ? "live" : "neutral",
        label: d.visible ? "Visible" : "Hidden",
      }),
    },
    facts: (d) => [
      { id: "mode", label: "Render", value: d.renderMode },
      { id: "qty", label: "Field", value: d.surfaceQuantity },
      { id: "vec", label: "Vectors", value: d.vectorsVisible ? "On" : "Off" },
      { id: "alpha", label: "Opacity", value: `${d.opacityPercent}%` },
    ],
    sections: [
      {
        id: "display-passes",
        title: "Visibility & Render Mode",
        icon: Eye,
        defaultOpen: true,
        rows: [
          {
            type: "switch",
            key: "visible",
            label: "Show target in 3D viewport",
          },
          {
            type: "segmented",
            key: "renderMode",
            label: "Surface style",
            options: [
              { value: "surface", label: "Shaded" },
              { value: "surface+edges", label: "Edges" },
              { value: "wireframe", label: "Wireframe" },
              { value: "points", label: "Points" },
            ],
          },
          {
            type: "range",
            key: "opacityPercent",
            label: "Surface opacity",
            min: 0,
            max: 100,
            step: 5,
            unitSuffix: "%",
          },
        ],
      },
      {
        id: "scalar-colormap",
        title: "Surface Field & Colormap",
        icon: Palette,
        defaultOpen: true,
        rows: [
          {
            type: "select",
            key: "surfaceQuantity",
            label: "Field quantity",
            options: [
              { value: "m", label: "Magnetization m" },
              { value: "B_demag", label: "Demagnetizing field B_demag" },
              { value: "B_eff", label: "Effective field B_eff" },
              { value: "solid", label: "Uniform material tint" },
            ],
          },
          {
            type: "select",
            key: "palette",
            label: "Scientific colormap",
            options: [
              { value: "viridis", label: "Viridis" },
              { value: "coolwarm", label: "Coolwarm" },
              { value: "inferno", label: "Inferno" },
            ],
          },
        ],
      },
      {
        id: "vector-glyphs",
        title: "Vector Field Arrows",
        icon: ArrowRightLeft,
        defaultOpen: true,
        rows: [
          {
            type: "switch",
            key: "vectorsVisible",
            label: "Show vector arrows",
          },
          {
            type: "number",
            key: "vectorBudget",
            label: "Arrow budget",
            integer: true,
            min: 50,
            max: 50000,
          },
          ...(surfaces && surfaces.length > 0
            ? [
                {
                  type: "custom" as const,
                  label: "Object surfaces",
                  wide: true,
                  render: () => (
                    <div className="grid gap-1.5 rounded border border-fm-border p-2 text-xs">
                      <span className="font-medium text-fm-muted">
                        Object surfaces
                      </span>
                      {surfaces.map((part) => (
                        <div
                          className="flex items-center justify-between gap-2"
                          key={part.id}
                        >
                          <span>{part.label}</span>
                          <Switch
                            aria-label={`Toggle vectors on ${part.label}`}
                            checked={part.vectorsVisible}
                            onCheckedChange={(checked) =>
                              onToggleSurfaceVectors?.(part.id, checked)
                            }
                          />
                        </div>
                      ))}
                    </div>
                  ),
                },
              ]
            : []),
        ],
      },
    ],
    commitBar: {
      mode: "liveViewport",
      hasOverrides: (draft, base) => JSON.stringify(draft) !== JSON.stringify(base),
      onResetDisplay,
    },
  };
}

function deriveRenderModeFromSettings(settings: {
  pointsVisible?: boolean;
  shaderVisible?: boolean;
  wireframeVisible?: boolean;
} | null): string {
  if (!settings) return "surface";
  if (settings.pointsVisible && !settings.shaderVisible) return "points";
  if (settings.wireframeVisible && settings.shaderVisible) return "surface+edges";
  if (settings.wireframeVisible) return "wireframe";
  return "surface";
}

function patchFromVisualizationDraft(
  draft: TargetVisualizationDraft,
): VisualizationTargetPatch {
  const shaderVisible =
    draft.renderMode === "surface" || draft.renderMode === "surface+edges";
  const wireframeVisible =
    draft.renderMode === "wireframe" || draft.renderMode === "surface+edges";
  const pointsVisible = draft.renderMode === "points";
  return {
    visible: draft.visible,
    shaderVisible,
    wireframeVisible,
    pointsVisible,
    activeQuantityId: draft.surfaceQuantity === "solid" ? "m" : draft.surfaceQuantity,
    surfaceColorSource: draft.surfaceQuantity === "solid" ? "solid" : "colormap",
    surfaceOpacityPercent: draft.opacityPercent,
    ...scalarColorPalettePatch(draft.palette),
    vectorsVisible: draft.vectorsVisible,
    vectorBudget: draft.vectorBudget,
  };
}

function ConnectedTargetVisualizationView({
  breadcrumbs,
  idPrefix,
  includeObjectSurfaces,
  kindLabel,
  onToggleSurfaceVectorsProp,
  selection,
  titleFallback,
}: {
  breadcrumbs: readonly string[];
  idPrefix: string;
  includeObjectSurfaces?: boolean;
  kindLabel: string;
  onToggleSurfaceVectorsProp?: (partId: string, visible: boolean) => void;
  selection: InspectorPanelProps["selection"];
  titleFallback: string;
}) {
  const kernel = useKernel();
  const visualization = useObjectVisualizationController();
  const visualizationState = useVisualizationStateResource();
  const manifest = useMeshSharedDomainManifestResource();
  const scene = useSceneResource();
  const snapshot = useObjectVisualizationSelector((s) => s);

  const resolvedTarget = useMemo(
    () => resolveVisualizationTargetFromSelection(selection),
    [selection],
  );
  const sceneObjectIds = useMemo(
    () => visualizationSceneObjectIds(scene.data),
    [scene.data],
  );
  const displayVisualizationState =
    visualizationState.optimisticData ?? visualizationState.data ?? null;

  const hasFullSnapshot = Boolean(
    snapshot && typeof snapshot === "object" && "defaults" in snapshot && snapshot.defaults,
  );

  const targetVisualization = useMemo(
    () =>
      resolvedTarget && hasFullSnapshot
        ? resolveTargetVisualization({
            snapshot,
            target: resolvedTarget,
            visualizationState: displayVisualizationState,
          })
        : null,
    [displayVisualizationState, hasFullSnapshot, resolvedTarget, snapshot],
  );
  const settings = targetVisualization?.settings ?? null;

  const hydratedBaseline = useMemo<TargetVisualizationDraft>(
    () => ({
      visible: settings?.visible ?? true,
      renderMode: deriveRenderModeFromSettings(settings),
      surfaceQuantity:
        settings?.surfaceColorSource === "solid"
          ? "solid"
          : (settings?.activeQuantityId ?? "m"),
      palette: settings?.scalarColorPalette ?? "viridis",
      vectorsVisible: settings?.vectorsVisible ?? true,
      vectorBudget: settings?.vectorBudget ?? 2500,
      opacityPercent: settings?.surfaceOpacityPercent ?? 100,
      phaseDeg: 0,
    }),
    [settings],
  );

  const liveSurfaces = useMemo<readonly SurfacePartVectorRow[]>(() => {
    if (!includeObjectSurfaces || !resolvedTarget) return [];
    const scopedPartRows = resolveSelectedTargetVectorMeshPartRows({
      manifestRegions: manifest.data?.regions,
      meshParts: manifest.data?.mesh_parts,
      sceneObjectIds,
      target: resolvedTarget,
      visualizationState: displayVisualizationState,
    });
    if (scopedPartRows.length === 0) return [];
    const rawMeshParts = manifest.data?.mesh_parts ?? [];
    return scopedPartRows.map((part) => {
      const matchedPart = rawMeshParts.find(
        (candidate) => candidate.id === part.id,
      );
      const partTarget = matchedPart
        ? resolveObjectVisualizationPanelTarget({
            part: matchedPart,
            sceneObjectIds,
            visualizationState: displayVisualizationState,
          })
        : null;
      const partSettings = partTarget && hasFullSnapshot
        ? resolveTargetVisualization({
            inheritedSettings: settings ?? undefined,
            snapshot,
            target: partTarget,
            visualizationState: displayVisualizationState,
          }).settings
        : null;
      return {
        id: part.id,
        label: part.label,
        vectorsVisible:
          partSettings?.vectorsVisible ?? settings?.vectorsVisible ?? false,
      };
    });
  }, [
    displayVisualizationState,
    hasFullSnapshot,
    includeObjectSurfaces,
    manifest.data?.mesh_parts,
    manifest.data?.regions,
    resolvedTarget,
    sceneObjectIds,
    settings,
    snapshot,
  ]);

  const applyTargetPatch = useCallback(
    (patchValue: VisualizationTargetPatch) => {
      if (!resolvedTarget) return;
      const targetKey = visualizationTargetKey(resolvedTarget);
      if (resolvedTarget.kind === "airbox") {
        const localPatch =
          airboxLocalVisualizationPatchFromTargetPatch(patchValue);
        if (Object.keys(localPatch).length > 0) {
          visualization.patchViewportPreferences(resolvedTarget, localPatch);
        }
        const statePatch = airboxVisualizationStatePatchFromTargetPatch(
          patchValue,
          displayVisualizationState?.overrides,
        );
        if (!hasVisualizationStatePatch(statePatch)) return;
        const receipt = kernel.visualizationSync.queuePatch(statePatch, [
          targetKey,
        ]);
        visualization.patchTargetPending(
          resolvedTarget,
          persistentVisualizationTargetPatch(patchValue),
          visualizationState.rawData?.revision ??
            visualizationState.data?.revision ??
            0,
          receipt.transactionId,
        );
        return;
      }
      const remotePatch = persistentVisualizationTargetPatch(patchValue);
      if (Object.keys(remotePatch).length > 0) {
        const overrides = mergeVisualizationStateTargetOverride(
          displayVisualizationState?.overrides ?? [],
          resolvedTarget,
          remotePatch,
        );
        const receipt = kernel.visualizationSync.queuePatch(
          { overrides },
          [targetKey],
        );
        visualization.patchTargetPending(
          resolvedTarget,
          remotePatch,
          visualizationState.rawData?.revision ??
            visualizationState.data?.revision ??
            0,
          receipt.transactionId,
        );
      }
    },
    [
      displayVisualizationState?.overrides,
      kernel.visualizationSync,
      resolvedTarget,
      visualization,
      visualizationState.data?.revision,
      visualizationState.rawData?.revision,
    ],
  );

  const handleAfterFieldChange = useCallback(
    (_key: string, _val: unknown, nextDraft: TargetVisualizationDraft) => {
      applyTargetPatch(patchFromVisualizationDraft(nextDraft));
    },
    [applyTargetPatch],
  );

  const handleToggleSurface = useCallback(
    (partId: string, visible: boolean) => {
      onToggleSurfaceVectorsProp?.(partId, visible);
      const stateSnapshot: VisualizationStateResource =
        displayVisualizationState ?? ({ overrides: [] } as unknown as VisualizationStateResource);
      toggleObjectSurfacePartVectors({
        controller: visualization,
        meshParts: manifest.data?.mesh_parts ?? [],
        partId,
        sceneObjectIds,
        state: stateSnapshot,
        sync: kernel.visualizationSync,
        visible,
      });
    },
    [
      displayVisualizationState,
      kernel.visualizationSync,
      manifest.data?.mesh_parts,
      onToggleSurfaceVectorsProp,
      sceneObjectIds,
      visualization,
    ],
  );

  const handleResetDisplay = useCallback(() => {
    if (!resolvedTarget) return;
    const targetKey = visualizationTargetKey(resolvedTarget);
    const fallbackState =
      displayVisualizationState ??
      ({ overrides: [] } as unknown as VisualizationStateResource);
    if (resolvedTarget.kind === "airbox") {
      kernel.visualizationSync.queuePatch(
        resetAirboxVisualizationState(fallbackState),
        [targetKey],
      );
      visualization.clearTarget(resolvedTarget);
      return;
    }
    kernel.visualizationSync.queuePatch(
      {
        overrides: visualizationOverridesForTargetReset(
          fallbackState,
          resolvedTarget,
        ),
      },
      [targetKey],
    );
    visualization.clearTarget(resolvedTarget);
  }, [
    displayVisualizationState,
    kernel.visualizationSync,
    resolvedTarget,
    visualization,
  ]);

  const spec = useMemo(
    () =>
      buildTargetVisualizationSpec({
        idPrefix,
        breadcrumbs,
        titleFallback,
        kindLabel,
        selection,
        surfaces: liveSurfaces,
        onToggleSurfaceVectors: handleToggleSurface,
        onResetDisplay: handleResetDisplay,
      }),
    [
      breadcrumbs,
      handleResetDisplay,
      handleToggleSurface,
      idPrefix,
      kindLabel,
      liveSurfaces,
      selection,
      titleFallback,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={hydratedBaseline}
      selection={selection}
      spec={spec}
      onAfterFieldChange={handleAfterFieldChange}
    />
  );
}

// ============================================================================
// 9 Exported Canonical Template Panels
// ============================================================================

export function ObjectVisualizationTemplatePanel({
  onToggleSurfaceVectors,
  selection,
  testSurfaces,
}: InspectorPanelProps & {
  onToggleSurfaceVectors?: (partId: string, visible: boolean) => void;
  testSurfaces?: readonly SurfacePartVectorRow[];
}) {
  const kernel = useOptionalKernel();
  const breadcrumbs = useMemo(
    () => [
      "Model",
      "Objects",
      selection.objectId ?? selection.label ?? "Object",
      "Visualization",
    ],
    [selection.label, selection.objectId],
  );

  if (hasFullVisualizationKernel(kernel) && !testSurfaces) {
    return (
      <HostedVisualizationTemplateShell
        breadcrumbs={breadcrumbs}
        commitMode="liveViewport"
        entityId={selection.objectId ?? selection.nodeId ?? undefined}
        facts={[
          { id: "scope", label: "Scope", value: "Object" },
          ...(selection.objectId
            ? [{ id: "object", label: "Object", value: selection.objectId }]
            : []),
        ]}
        icon={Eye}
        kindLabel="Object-scoped 3D & 2D rendering, field colormap & vectors"
        ownerId="object.visualization"
        sectionTitle="Field & Surface Visualization"
        selection={selection}
        statePill={{ tone: "live", label: "Live viewport" }}
        title={selection.label || "Object Visualization"}
      >
        <ObjectVisualizationEntryPanel selection={selection} />
      </HostedVisualizationTemplateShell>
    );
  }

  if (kernel && !testSurfaces) {
    return (
      <ConnectedTargetVisualizationView
        breadcrumbs={breadcrumbs}
        idPrefix="object.visualization"
        includeObjectSurfaces
        kindLabel="Object-scoped 3D rendering & field glyphs"
        selection={selection}
        titleFallback="Object Visualization"
        onToggleSurfaceVectorsProp={onToggleSurfaceVectors}
      />
    );
  }

  return (
    <FallbackObjectVisualizationPanel
      selection={selection}
      testSurfaces={testSurfaces}
      onToggleSurfaceVectors={onToggleSurfaceVectors}
    />
  );
}

function FallbackObjectVisualizationPanel({
  onToggleSurfaceVectors,
  selection,
  testSurfaces,
}: InspectorPanelProps & {
  onToggleSurfaceVectors?: (partId: string, visible: boolean) => void;
  testSurfaces?: readonly SurfacePartVectorRow[];
}) {
  const [baseline] = useState<TargetVisualizationDraft>(DEFAULT_VIZ_DRAFT);
  const [localSurfaces, setLocalSurfaces] = useState<
    readonly SurfacePartVectorRow[]
  >(() => testSurfaces ?? []);
  const surfaces = testSurfaces ?? localSurfaces;

  const handleToggle = useCallback(
    (partId: string, visible: boolean) => {
      onToggleSurfaceVectors?.(partId, visible);
      setLocalSurfaces((prev) =>
        prev.map((item) =>
          item.id === partId ? { ...item, vectorsVisible: visible } : item,
        ),
      );
    },
    [onToggleSurfaceVectors],
  );

  const spec = useMemo(
    () =>
      buildTargetVisualizationSpec({
        idPrefix: "object.visualization",
        breadcrumbs: [
          "Model",
          "Geometry",
          selection.label || "Object",
          "Visualization",
        ],
        titleFallback: "Object Visualization",
        kindLabel: "Object-scoped 3D rendering & field glyphs",
        selection,
        surfaces,
        onToggleSurfaceVectors: handleToggle,
        onResetDisplay: () => setLocalSurfaces(testSurfaces ?? []),
      }),
    [handleToggle, selection, surfaces, testSurfaces],
  );

  return (
    <ConnectedInspectorSpec baseline={baseline} selection={selection} spec={spec} />
  );
}

export function ObjectRegionVisualizationTemplatePanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useOptionalKernel();
  const breadcrumbs = useMemo(
    () => ["Model", "Object", "Regions", selection.label || "Region"],
    [selection.label],
  );

  if (hasFullVisualizationKernel(kernel)) {
    return (
      <HostedVisualizationTemplateShell
        breadcrumbs={breadcrumbs}
        commitMode="liveViewport"
        entityId={selection.nodeId ?? selection.objectId ?? undefined}
        facts={[
          { id: "scope", label: "Scope", value: "Object region" },
          ...(selection.objectId
            ? [{ id: "parent", label: "Parent", value: selection.objectId }]
            : []),
        ]}
        icon={Eye}
        kindLabel="Sub-object region rendering & field overrides"
        ownerId="object.region.visualization"
        sectionTitle="Region Field & Surface Visualization"
        selection={selection}
        statePill={{ tone: "live", label: "Live viewport" }}
        title={selection.label || "Region Visualization"}
      >
        <ObjectVisualizationPanel
          ownerOverride={OBJECT_REGION_VISUALIZATION_OWNER}
          selection={selection}
        />
      </HostedVisualizationTemplateShell>
    );
  }

  if (kernel) {
    return (
      <ConnectedTargetVisualizationView
        breadcrumbs={breadcrumbs}
        idPrefix="object.region.visualization"
        kindLabel="Sub-object region rendering overrides"
        selection={selection}
        titleFallback="Region Visualization"
      />
    );
  }

  return (
    <FallbackSimpleTargetVizPanel
      breadcrumbs={breadcrumbs}
      idPrefix="object.region.visualization"
      kindLabel="Sub-object region rendering overrides"
      selection={selection}
      titleFallback="Region Visualization"
    />
  );
}

export function MeshPartVisualizationTemplatePanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useOptionalKernel();
  const breadcrumbs = useMemo(
    () => ["Mesh", "Parts", selection.label || "Mesh Part"],
    [selection.label],
  );

  if (hasFullVisualizationKernel(kernel)) {
    return (
      <HostedVisualizationTemplateShell
        breadcrumbs={breadcrumbs}
        commitMode="liveViewport"
        entityId={selection.nodeId ?? undefined}
        facts={[{ id: "scope", label: "Scope", value: "Mesh part" }]}
        icon={Eye}
        kindLabel="Part-scoped FEM / FDM carrier display"
        ownerId="mesh-part.visualization"
        sectionTitle="Mesh-part Carrier Visualization"
        selection={selection}
        statePill={{ tone: "live", label: "Live viewport" }}
        title={selection.label || "Mesh-part Visualization"}
      >
        <MeshPartVisualizationPanel selection={selection} />
      </HostedVisualizationTemplateShell>
    );
  }

  if (kernel) {
    return (
      <ConnectedTargetVisualizationView
        breadcrumbs={breadcrumbs}
        idPrefix="mesh-part.visualization"
        kindLabel="Part-scoped FEM / FDM carrier display"
        selection={selection}
        titleFallback="Mesh Part Visualization"
      />
    );
  }

  return (
    <FallbackSimpleTargetVizPanel
      breadcrumbs={breadcrumbs}
      idPrefix="mesh-part.visualization"
      kindLabel="Part-scoped FEM / FDM carrier display"
      selection={selection}
      titleFallback="Mesh Part Visualization"
    />
  );
}

export function AirboxVisualizationTemplatePanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useOptionalKernel();
  const breadcrumbs = useMemo(
    () => ["Model", "Airbox", "Visualization"],
    [],
  );

  if (hasFullVisualizationKernel(kernel)) {
    return (
      <HostedVisualizationTemplateShell
        breadcrumbs={breadcrumbs}
        commitMode="liveViewport"
        entityId="airbox"
        facts={[
          { id: "scope", label: "Scope", value: "Universe (Airbox)" },
          { id: "carrier", label: "Domain", value: "Stray & Oersted field" },
        ]}
        icon={Eye}
        kindLabel="Stray-field & magnetostatic Airbox display"
        ownerId="airbox.visualization"
        sectionTitle="Universe Field & Bounds Visualization"
        selection={selection}
        statePill={{ tone: "live", label: "Live viewport" }}
        title={selection.label || "Airbox Visualization"}
      >
        <AirboxVisualizationPanel selection={selection} />
      </HostedVisualizationTemplateShell>
    );
  }

  if (kernel) {
    return (
      <ConnectedTargetVisualizationView
        breadcrumbs={breadcrumbs}
        idPrefix="airbox.visualization"
        kindLabel="Stray-field & magnetostatic airbox display"
        selection={selection}
        titleFallback="Airbox Visualization"
      />
    );
  }

  return (
    <FallbackSimpleTargetVizPanel
      breadcrumbs={breadcrumbs}
      idPrefix="airbox.visualization"
      kindLabel="Stray-field & magnetostatic airbox display"
      selection={selection}
      titleFallback="Airbox Visualization"
    />
  );
}

function FallbackSimpleTargetVizPanel({
  breadcrumbs,
  idPrefix,
  kindLabel,
  selection,
  titleFallback,
}: {
  breadcrumbs: readonly string[];
  idPrefix: string;
  kindLabel: string;
  selection: InspectorPanelProps["selection"];
  titleFallback: string;
}) {
  const spec = useMemo(
    () =>
      buildTargetVisualizationSpec({
        idPrefix,
        breadcrumbs,
        titleFallback,
        kindLabel,
        selection,
        onResetDisplay: () => undefined,
      }),
    [breadcrumbs, idPrefix, kindLabel, selection, titleFallback],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_VIZ_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function ModeVisualizationTemplatePanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useOptionalKernel();
  const breadcrumbs = useMemo(
    () => ["Results", selection.label || "Mode Visualization"],
    [selection.label],
  );

  if (hasFullVisualizationKernel(kernel)) {
    return (
      <HostedVisualizationTemplateShell
        breadcrumbs={breadcrumbs}
        commitMode="liveViewport"
        entityId={selection.nodeId ?? undefined}
        facts={[
          { id: "carrier", label: "Encoding", value: "Re(delta_m · e^(-i phi))" },
          ...(selection.objectId
            ? [{ id: "object", label: "Object", value: selection.objectId }]
            : []),
        ]}
        icon={Sparkles}
        kindLabel="Harmonic spatial mode overlay"
        ownerId="object.mode_visualization"
        sectionTitle="Mode & Object Visualization"
        selection={selection}
        statePill={{ tone: "live", label: "Active overlay" }}
        title={selection.label || "Mode Visualization"}
        onExtraReset={() => {
          kernel.analysisFieldOverlay?.update?.({ visualizationPhaseRad: 0 });
        }}
      >
        {selection.kind === "results.eigen.modes.visualization" &&
        selection.ref?.type !== "mode-visualization" ? (
          <EigenModesVisualizationInspectorPanel selection={selection} />
        ) : null}
        <ModeVisualizationOverviewPanel selection={selection} />
      </HostedVisualizationTemplateShell>
    );
  }

  return <FallbackModeVisualizationPanel kernel={kernel} selection={selection} />;
}

function FallbackModeVisualizationPanel({
  kernel,
  selection,
}: InspectorPanelProps & { kernel: KernelApi | null }) {
  const [phaseDeg, setPhaseDeg] = useState(0);
  const spec = useMemo<InspectorSpec<TargetVisualizationDraft>>(
    () => ({
      id: "object.mode_visualization",
      header: {
        breadcrumbs: [
          { id: "res", label: "Results" },
          { id: "mode", label: selection.label || "Mode Visualization" },
        ],
        canFitView: true,
      },
      identity: {
        domain: "visualization",
        icon: Sparkles,
        title: () => selection.label || "3D Mode Visualization",
        kindLabel: "Harmonic spatial mode overlay",
        statePill: () => ({ tone: "live", label: "Active overlay" }),
      },
      facts: () => [
        { id: "phase", label: "Phase", value: `${phaseDeg.toFixed(0)} deg` },
        { id: "carrier", label: "Encoding", value: "Re(delta_m · e^(-i phi))" },
      ],
      sections: [
        {
          id: "harmonic-phase",
          title: "Harmonic Phase & Gain",
          icon: Play,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Phase scrubber",
              wide: true,
              render: () => (
                <Slider
                  aria-label="Mode visualization phase"
                  max={360}
                  min={0}
                  step={1}
                  value={[phaseDeg]}
                  valueText={(v) => `${v} degrees`}
                  onValueChange={(vals) => {
                    const next = vals[0] ?? 0;
                    setPhaseDeg(next);
                    kernel?.analysisFieldOverlay?.update({
                      visualizationPhaseRad: (next * Math.PI) / 180,
                    });
                  }}
                />
              ),
            },
            {
              type: "quantity",
              key: "phaseDeg",
              label: "Phase offset",
              units: ANGLE_RAD_UNITS_SI,
              defaultDisplayUnit: "deg",
            },
          ],
        },
      ],
      commitBar: {
        mode: "liveViewport",
        hasOverrides: () => phaseDeg !== 0,
        onResetDisplay: () => {
          setPhaseDeg(0);
          kernel?.analysisFieldOverlay?.update({
            visualizationPhaseRad: 0,
          });
        },
      },
    }),
    [kernel, phaseDeg, selection.label],
  );
  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_VIZ_DRAFT}
      selection={selection}
      spec={spec}
      onAfterFieldChange={(key, val) => {
        if (key === "phaseDeg" && typeof val === "number" && Number.isFinite(val)) {
          const deg = (val * 180) / Math.PI;
          setPhaseDeg(deg);
          kernel?.analysisFieldOverlay?.update({ visualizationPhaseRad: val });
        }
      }}
    />
  );
}

function FallbackVisualizationDebugView({
  idPrefix,
  model,
  selection,
  targetId,
  targetLabel,
  title,
}: {
  idPrefix: string;
  model: VisualizationDebugPanelModel | null;
  selection: InspectorPanelProps["selection"];
  targetId: string;
  targetLabel: string;
  title: string;
}) {
  const snapshots = useMemo(
    () => (model ? uniqueSnapshots(model) : []),
    [model],
  );
  const observations = useMemo(
    () => (model ? allObservations(model) : []),
    [model],
  );
  const issues = useMemo(() => (model ? allIssues(model) : []), [model]);
  const memGroups = useMemo(() => (model ? memoryGroups(model) : []), [model]);
  const emptyMsg = model
    ? visualizationDebugEmptyStateMessage(model.state)
    : null;

  const spec = useMemo<InspectorSpec<TargetVisualizationDraft>>(
    () => ({
      id: idPrefix,
      header: {
        breadcrumbs: [
          { id: "viz", label: "Visualization" },
          { id: "dbg", label: title },
        ],
      },
      identity: {
        domain: "visualization",
        icon: Bug,
        title: () => title,
        kindLabel: `${targetLabel} carrier adoption & transport telemetry`,
        entityId: targetId,
        statePill: () => ({
          tone:
            issues.length > 0
              ? "warn"
              : snapshots.length > 0
                ? "ok"
                : "info",
          label:
            issues.length > 0
              ? `${issues.length} issues`
              : snapshots.length > 0
                ? "Evidence active"
                : "Diagnostic",
        }),
      },
      facts: () => [
        { id: "owner", label: "Owner", value: idPrefix },
        { id: "target", label: "Target", value: targetId },
        {
          id: "carriers",
          label: "Carriers",
          value: String(observations.length),
        },
        {
          id: "snapshots",
          label: "Snapshots",
          value: String(snapshots.length),
        },
      ],
      sections: [
        {
          id: "carrier-adoption",
          title: "Carrier Adoption & Frame Evidence",
          icon: Layers,
          defaultOpen: true,
          rows: [
            {
              type: "readonly",
              label: "Target scope",
              format: () => `${targetLabel} (${targetId})`,
            },
            {
              type: "readonly",
              label: "Disposition",
              format: () =>
                model
                  ? `${model.disposition} · ${observations.length} carrier observations`
                  : "Bounded frame evidence ready",
            },
            ...(emptyMsg && observations.length === 0
              ? [
                  {
                    type: "custom" as const,
                    label: "Debug state",
                    wide: true,
                    render: () => (
                      <EmptyState
                        description={emptyMsg.detail}
                        heading={emptyMsg.title}
                      />
                    ),
                  },
                ]
              : observations.map(({ carrier }, idx) => ({
                  type: "readonly" as const,
                  label: `Carrier #${idx + 1}`,
                  mono: true,
                  format: () =>
                    `${carrier.carrierId} (${carrier.carrierRole})`,
                }))),
            ...(issues.map((issue, idx) => ({
              type: "readonly" as const,
              label: `Issue #${idx + 1}`,
              format: () => `${issue.code}: ${issue.message}`,
            }))),
            ...(model
              ? [
                  {
                    type: "custom" as const,
                    label: "Export evidence",
                    wide: true,
                    render: ({ notify }: { notify: (msg: string) => void }) => (
                      <Button
                        size="sm"
                        type="button"
                        variant="secondary"
                        onClick={() => {
                          const exported = buildVisualizationDebugExport(
                            model,
                            Date.now(),
                          );
                          void navigator?.clipboard?.writeText?.(exported.json);
                          notify("Copied visualization debug evidence JSON");
                        }}
                      >
                        <Clipboard size={13} aria-hidden="true" />
                        <span>Copy JSON Evidence</span>
                      </Button>
                    ),
                  },
                ]
              : []),
          ],
        },
        {
          id: "transport-telemetry",
          title: "GPU & Binary Transport",
          icon: Activity,
          defaultOpen: memGroups.length > 0,
          rows:
            memGroups.length > 0
              ? memGroups.map((group) => ({
                  type: "readonly" as const,
                  label: `Memory (${group.ownership})`,
                  mono: true,
                  format: () =>
                    group.total !== null ? formatBytes(group.total) : "—",
                }))
              : [
                  {
                    type: "readonly",
                    label: "Transfer plane",
                    format: () => "Typed float32 carrier buffer",
                  },
                ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      emptyMsg,
      idPrefix,
      issues,
      memGroups,
      model,
      observations,
      snapshots.length,
      targetId,
      targetLabel,
      title,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_VIZ_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

export function AirboxVisualizationDebugTemplatePanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useOptionalKernel();
  const targetId = resolveDebugTargetId(selection);
  const breadcrumbs = useMemo(
    () => ["Model", "Airbox", "Visualization", "Debug"],
    [],
  );

  if (hasFullVisualizationKernel(kernel)) {
    return (
      <HostedVisualizationTemplateShell
        breadcrumbs={breadcrumbs}
        canFitView={false}
        commitMode="readOnly"
        entityId={targetId}
        facts={[
          { id: "owner", label: "Owner", value: "airbox.visualization.debug" },
          { id: "target", label: "Target", value: targetId },
        ]}
        icon={Bug}
        kindLabel="Airbox carrier adoption & transport telemetry"
        ownerId="airbox.visualization.debug"
        sectionTitle="Diagnostic Evidence"
        selection={selection}
        statePill={{ tone: "info", label: "Diagnostic" }}
        title="Airbox Visualization Debug"
      >
        <AirboxVisualizationDebugContent selection={selection} />
      </HostedVisualizationTemplateShell>
    );
  }

  return (
    <FallbackVisualizationDebugView
      idPrefix="airbox.visualization.debug"
      model={null}
      selection={selection}
      targetId={targetId}
      targetLabel="Airbox target"
      title="Airbox Visualization Debug"
    />
  );
}

function makeVisualizationDebugOwnerPanel(owner: VisualizationDebugOwnerContract) {
  function VisualizationDebugTemplateOwner({ selection }: InspectorPanelProps) {
    const kernel = useOptionalKernel();
    const targetId = resolveDebugTargetId(selection);
    const breadcrumbs = useMemo(
      () => ["Visualization", owner.title],
      [],
    );

    if (hasFullVisualizationKernel(kernel)) {
      return (
        <HostedVisualizationTemplateShell
          breadcrumbs={breadcrumbs}
          canFitView={false}
          commitMode="readOnly"
          entityId={targetId}
          facts={[
            { id: "owner", label: "Owner", value: owner.id },
            { id: "target", label: "Target", value: targetId },
          ]}
          icon={Bug}
          kindLabel={`${owner.targetLabel} carrier adoption & transport telemetry`}
          ownerId={owner.id}
          sectionTitle="Diagnostic Evidence"
          selection={selection}
          statePill={{ tone: "info", label: "Diagnostic" }}
          title={owner.title}
        >
          <VisualizationDebugOwnerBody owner={owner} selection={selection} />
        </HostedVisualizationTemplateShell>
      );
    }

    return (
      <FallbackVisualizationDebugView
        idPrefix={owner.id}
        model={null}
        selection={selection}
        targetId={targetId}
        targetLabel={owner.targetLabel}
        title={owner.title}
      />
    );
  }
  return VisualizationDebugTemplateOwner;
}

export const ObjectVisualizationDebugTemplatePanel =
  makeVisualizationDebugOwnerPanel(OBJECT_VISUALIZATION_DEBUG_OWNER);

export const ObjectRegionVisualizationDebugTemplatePanel =
  makeVisualizationDebugOwnerPanel(OBJECT_REGION_VISUALIZATION_DEBUG_OWNER);

export const MeshPartVisualizationDebugTemplatePanel =
  makeVisualizationDebugOwnerPanel(MESH_PART_VISUALIZATION_DEBUG_OWNER);
