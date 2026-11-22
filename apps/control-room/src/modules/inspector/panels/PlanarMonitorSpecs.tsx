"use client";

import {
  Box,
  Compass,
  Copy,
  Crosshair,
  Eye,
  Layers,
  Palette,
  Plus,
  RotateCcw,
  Slice,
  Trash2,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  MODEL_PLANAR_MONITORS_PATH,
  VISUALIZATION_STATE_PATH,
} from "@/kernel/api/apiPaths";
import type { VisualizationStatePatch } from "@/kernel/api/apiTypes";
import {
  authoringWriteOptions,
  runAuthoringMutationWithHistory,
} from "@/kernel/authoring/authoringHistoryMutation";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { CommandId } from "@/kernel/commands/commandTypes";
import { KernelContext, useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import {
  usePlanarMonitorResource,
  usePlanarMonitorsResource,
} from "@/kernel/resources/planarMonitorResources";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import {
  useSessionResourceIdentity,
  useSessionStatusSelector,
} from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import {
  crossSectionWorkspaceStore,
  discardPlanarMonitorDraft,
  isPlanarMonitorRevisionConflict,
  planarMonitorCreateRequestFromDraft,
  planarMonitorDraftFromMonitor,
  planarMonitorIdentityForCreate,
  planarMonitorValidationErrors,
  updatePlanarMonitorDraft,
  type PlanarMonitor,
  type PlanarMonitorDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import {
  planarMonitorFramePreviewStore,
  usePlanarMonitorPickFaceArmed,
} from "@/kernel/workspace/planarMonitorFramePreview";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { EmptyState } from "@/shared/ui/EmptyState";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";

import {
  formatInspectorSessionKey,
  useRegisterInspectorEditSessionV2,
  type InspectorEditSessionV2,
} from "../InspectorEditSession";
import { inspectorFitCommandId } from "../inspectorFitCommand";
import type { InspectorPanelProps } from "../inspectorTypes";
import {
  InspectorTemplate,
  type InspectorNotice,
  type InspectorSpec,
} from "../template";
import {
  defaultPlanarDisplayPatch,
  planarDisplayDiffersFromDefault,
} from "../visualization/planarDisplayDefaults";
import { PlanarVisualizationSection } from "../visualization/PlanarVisualizationSection";
import { VisualizationContextSwitch } from "../visualization/VisualizationContextSwitch";
import { PlanarMonitorDefinitionEditor } from "./PlanarMonitorDefinitionEditor";
import {
  planarMonitorDefinitionAvailabilityErrors,
  resolvePlanarMonitorDefinitionAvailability,
  type PlanarMonitorDefinitionAvailability,
} from "./PlanarMonitorDefinitionEditor.model";
import {
  ConnectedInspectorSpec,
  LENGTH_UNITS_SI,
} from "./study/ConnectedInspectorSpec";

/* ── Safe availability hook (supports partial unit-test module mocks) ─────── */

type SafeResourceStatus = "idle" | "loading" | "ready" | "error";

interface SafeModelRegionsResult {
  data: {
    regions: readonly { owner_object_id?: string | null; region_id: string }[];
  } | null;
  status: SafeResourceStatus;
}

interface SafeFdmMembershipResult {
  availability?: { status: SafeResourceStatus };
  data: {
    object_ids?: readonly string[];
    region_legend?: readonly { object_id: string; region_id: string }[];
  } | null;
  status?: SafeResourceStatus;
}

const fallbackModelRegionsHook = (
  _options?: { enabled?: boolean },
): SafeModelRegionsResult => ({
  data: null,
  status: "idle",
});

const fallbackFdmMembershipHook = (
  _options?: { enabled?: boolean },
): SafeFdmMembershipResult => ({
  availability: { status: "idle" },
  data: null,
  status: "idle",
});

function resolveOptionalHook<THook>(
  key: keyof typeof geometryLifecycleResources,
  fallback: THook,
): THook {
  try {
    const candidate = geometryLifecycleResources[key];
    return typeof candidate === "function" ? (candidate as unknown as THook) : fallback;
  } catch {
    return fallback;
  }
}

const useSafeModelRegionsResource = resolveOptionalHook<
  (options?: { enabled?: boolean }) => SafeModelRegionsResult
>("useModelRegionsResource", fallbackModelRegionsHook);

const useSafeFdmRegionMembershipResource = resolveOptionalHook<
  (options?: { enabled?: boolean }) => SafeFdmMembershipResult
>("useFdmRegionMembershipResource", fallbackFdmMembershipHook);

function useSafePlanarMonitorDefinitionAvailability(): PlanarMonitorDefinitionAvailability {
  const discretization = useSessionStatusSelector((status) => {
    const resolved = resolveSessionDiscretization(
      status.data as Parameters<typeof resolveSessionDiscretization>[0],
    );
    if (resolved) return resolved;
    const raw = status.data as { discretization?: unknown } | null | undefined;
    return raw?.discretization === "fdm" || raw?.discretization === "fem"
      ? raw.discretization
      : null;
  });
  const scene = geometryLifecycleResources.useSceneResource({
    enabled: discretization === "fdm" || discretization === "fem",
  });
  const regions = useSafeModelRegionsResource({
    enabled: discretization === "fdm" || discretization === "fem",
  });
  const fdmMembership = useSafeFdmRegionMembershipResource({
    enabled: discretization === "fdm",
  });
  const manifest = geometryLifecycleResources.useMeshSharedDomainManifestResource(
    {
      enabled: discretization === "fem",
    },
  );

  return useMemo(
    () =>
      resolvePlanarMonitorDefinitionAvailability({
        discretization,
        fdmObjectIds:
          fdmMembership?.availability?.status === "ready"
            ? (fdmMembership.data?.object_ids ?? [])
            : null,
        fdmRegionRefs:
          fdmMembership?.availability?.status === "ready"
            ? (fdmMembership.data?.region_legend ?? []).map((entry) => ({
                objectId: entry.object_id,
                regionId: entry.region_id,
              }))
            : null,
        femTopologyReady:
          manifest?.status === "ready" && manifest.data !== null,
        modelRegionRefs:
          regions?.status === "ready" && regions.data
            ? regions.data.regions.flatMap((entry) =>
                entry.owner_object_id
                  ? [
                      {
                        objectId: entry.owner_object_id,
                        regionId: entry.region_id,
                      },
                    ]
                  : [],
              )
            : null,
        sceneObjectIds:
          scene?.status === "ready" && scene.data
            ? (scene.data.objects ?? []).map((entry) => entry.id)
            : null,
      }),
    [discretization, fdmMembership, manifest, regions, scene],
  );
}

/* ── Shared types & fallback helpers (for isolated kernel === null tests) ─── */

interface PlanarMonitorGeometryDraft {
  name: string;
  normalPreset: "xy" | "xz" | "yz" | "custom";
  planeOffsetM: number;
  normalVector: readonly [number, number, number];
  samplesU: number;
  samplesV: number;
}

interface PlanarDisplayViewportState {
  colormap: string;
  showArrows: boolean;
  symmetricRange: boolean;
}

interface PlanarMonitorTemplateDraft extends PlanarMonitorDraft {
  name: string;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

const DEFAULT_PLANAR_GEOMETRY_DRAFT: PlanarMonitorGeometryDraft = {
  name: "xy_midplane",
  normalPreset: "xy",
  planeOffsetM: 0,
  normalVector: [0, 0, 1],
  samplesU: 128,
  samplesV: 128,
};

const DEFAULT_PLANAR_DISPLAY: PlanarDisplayViewportState = {
  colormap: "cmcrameri_vik",
  showArrows: true,
  symmetricRange: true,
};

function toTemplateDraft(draft: PlanarMonitorDraft): PlanarMonitorTemplateDraft {
  return {
    ...draft,
    name: draft.monitor.name,
  };
}

function createDefaultCanonicalMonitor(name: string): PlanarMonitor {
  const id =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "planar_monitor";
  return {
    id,
    name: name.trim() || "Planar monitor",
    target: { kind: "magnetic_domain" },
    operator: { kind: "plane_sample" },
    frame: {
      normalization_version: "planar_frame_v1",
      preset: "xy",
      normal: [0, 0, 1],
      u_axis: [1, 0, 0],
      v_axis: [0, 1, 0],
      origin_m: [0, 0, 0],
      extent: { kind: "magnetic_domain", padding_m: 0 },
    },
  };
}

function formatMonitorOriginOffsetSummary(monitor: PlanarMonitor): string {
  const preset = monitor.frame.preset;
  const meters =
    preset === "xy"
      ? (monitor.frame.origin_m[2] ?? 0)
      : preset === "xz"
        ? (monitor.frame.origin_m[1] ?? 0)
        : preset === "yz"
          ? (monitor.frame.origin_m[0] ?? 0)
          : Math.hypot(
              monitor.frame.origin_m[0] ?? 0,
              monitor.frame.origin_m[1] ?? 0,
              monitor.frame.origin_m[2] ?? 0,
            );
  return `${Number((meters * 1e9).toFixed(2))} nm`;
}

function SafeVisualizationContextSwitch() {
  const kernel = useKernel();
  const hasFullLayoutStore =
    typeof (kernel.layout as { subscribe?: unknown } | undefined)?.subscribe ===
      "function" &&
    typeof (kernel.layout as { get?: unknown } | undefined)?.get === "function";
  const [fallbackMode, setFallbackMode] = useState<"three-d" | "planar">(
    "planar",
  );

  if (hasFullLayoutStore) {
    return <VisualizationContextSwitch />;
  }

  return (
    <SegmentedControl<"three-d" | "planar">
      aria-label="Visualization context"
      className="w-full"
      columns={2}
      options={[
        { label: "3D", value: "three-d" },
        { label: "2D", value: "planar" },
      ]}
      value={fallbackMode}
      onValueChange={(next) => {
        setFallbackMode(next);
        kernel.layout?.setActiveViewportMainModule?.(
          next === "planar" ? "field-map" : "viewport-3d",
        );
      }}
    />
  );
}

function ConnectedPlanar2DDisplayBody({
  monitorId,
  selection,
}: {
  monitorId: string;
  selection: Selection;
}) {
  const kernel = useKernel();
  const visualizationState = useVisualizationStateResource();
  const hasFullPlanarRuntime =
    typeof kernel.visualizationSync?.queuePlanarFieldOverlayPatch ===
      "function" &&
    typeof (kernel.resources as { subscribe?: unknown } | undefined)
      ?.subscribe === "function";

  const currentPlanar = visualizationState.data?.planar;
  const [localDisplay, setLocalDisplay] = useState<PlanarDisplayViewportState>(
    () => ({
      colormap:
        currentPlanar?.colormap === "batlow"
          ? "cmcrameri_batlow"
          : currentPlanar?.colormap === "direction" ||
              currentPlanar?.colormap === "hsl_direction"
            ? "hsl_spin"
            : "cmcrameri_vik",
      showArrows: currentPlanar?.layers?.vectors ?? false,
      symmetricRange: currentPlanar?.range?.mode === "symmetric",
    }),
  );

  const vectorsChecked =
    currentPlanar?.layers?.vectors ?? localDisplay.showArrows;

  const toggleViewVectors = (nextVectors: boolean) => {
    setLocalDisplay((prev) => ({ ...prev, showArrows: nextVectors }));
    const baseLayers = currentPlanar?.layers ?? {
      boundaries: false,
      bounds: false,
      contours: false,
      mesh: false,
      points: false,
      probes: true,
      raster: true,
      streamlines: false,
      vectors: false,
    };
    kernel.visualizationSync?.queuePatch({
      planar: {
        ...(currentPlanar?.source
          ? {}
          : { source: { kind: "monitor", monitor_id: monitorId } }),
        layers: {
          ...baseLayers,
          vectors: nextVectors,
        },
      },
    });
  };

  const applyFallbackDisplay = (patch: Partial<PlanarDisplayViewportState>) => {
    setLocalDisplay((prev) => {
      const next = { ...prev, ...patch };
      type PlanarPatch = NonNullable<VisualizationStatePatch["planar"]>;
      const mappedColormap: PlanarPatch["colormap"] =
        next.colormap === "cmcrameri_batlow"
          ? "batlow"
          : next.colormap === "hsl_spin"
            ? "direction"
            : "vik";
      const planarPatch: PlanarPatch = {
        source: currentPlanar?.source ?? {
          kind: "monitor",
          monitor_id: monitorId,
        },
        colormap: mappedColormap,
        range: next.symmetricRange
          ? { mode: "symmetric", min: null, max: null }
          : { mode: "auto", min: null, max: null },
        ...(currentPlanar?.layers
          ? {
              layers: {
                ...currentPlanar.layers,
                vectors: next.showArrows,
              },
            }
          : {}),
      };
      kernel.visualizationSync?.queuePatch({ planar: planarPatch });
      return next;
    });
  };

  return (
    <div className="grid min-w-0 gap-3 text-xs">
      <div className="grid gap-1.5">
        <span className="text-fm-muted">Active viewport surface</span>
        <SafeVisualizationContextSwitch />
      </div>

      <div className="flex items-center justify-between gap-2 rounded border border-fm-border px-2.5 py-2">
        <span>In-plane vector arrows</span>
        <Switch
          aria-label="Show 2D slice vector arrows"
          checked={vectorsChecked}
          onCheckedChange={toggleViewVectors}
        />
      </div>

      {hasFullPlanarRuntime ? (
        <PlanarVisualizationSection selection={selection} />
      ) : (
        <div className="grid gap-2.5">
          <div className="flex items-center justify-between gap-2">
            <span>Colormap</span>
            <div className="w-40">
              <Select
                value={localDisplay.colormap}
                onValueChange={(colormap) =>
                  applyFallbackDisplay({ colormap })
                }
              >
                <SelectTrigger aria-label="2D slice colormap" density="compact">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cmcrameri_vik">Vik (diverging)</SelectItem>
                  <SelectItem value="cmcrameri_batlow">Batlow</SelectItem>
                  <SelectItem value="hsl_spin">HSL in-plane</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span>Symmetric color scale</span>
            <Switch
              aria-label="Symmetric 2D color scale"
              checked={localDisplay.symmetricRange}
              onCheckedChange={(symmetricRange) =>
                applyFallbackDisplay({ symmetricRange })
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ── 1. model.planar.monitors — Overview ────────────────────────────────── */

export function PlanarMonitorsOverviewTemplatePanel(
  props: InspectorPanelProps,
) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedPlanarMonitorsOverviewPanel {...props} />;
  }
  return (
    <PlanarMonitorsOverviewView
      {...props}
      activeDraft={null}
      monitors={[]}
    />
  );
}

function ConnectedPlanarMonitorsOverviewPanel(props: InspectorPanelProps) {
  const monitorsRes = usePlanarMonitorsResource();
  const activeDraft = useCrossSectionWorkspaceSelector(
    (state) => state.planarMonitorDraft,
  );
  return (
    <PlanarMonitorsOverviewView
      {...props}
      activeDraft={activeDraft}
      monitors={monitorsRes.data?.monitors ?? []}
      sceneRevision={monitorsRes.data?.scene_revision}
    />
  );
}

function PlanarMonitorsOverviewView({
  activeDraft,
  monitors,
  sceneRevision,
  selection,
}: InspectorPanelProps & {
  activeDraft: PlanarMonitorDraft | null;
  monitors: readonly PlanarMonitor[];
  sceneRevision?: number;
}) {
  const kernel = useContext(KernelContext);

  const runCreateMonitor = useCallback(async () => {
    if (!kernel) return;
    await kernel.commands.execute(
      "planar-monitor.create",
      createCommandContext("inspector", kernel),
      { intent: { source: "inspector" } },
    );
  }, [kernel]);

  const selectMonitor = useCallback(
    (monitor: PlanarMonitor) => {
      const nodeId = `model:definitions:planar-monitors:${monitor.id}`;
      kernel?.selection.set(
        {
          kind: "model.planar.monitor",
          label: monitor.name,
          nodeId,
          objectId: null,
          ref: {
            kind: "model.planar.monitor",
            monitorId: monitor.id,
            nodeId,
            type: "planar-monitor",
            visualizationTargetId: `planar-monitor:${monitor.id}`,
          },
        },
        "inspector",
      );
    },
    [kernel],
  );

  const openMonitorIn2D = useCallback(
    (monitor: PlanarMonitor) => {
      if (!kernel) return;
      void kernel.commands.execute(
        "field-map.select-monitor",
        createCommandContext("inspector", kernel, {
          sourceDetail: "planar-monitors-overview",
        }),
        { monitorId: monitor.id },
      );
    },
    [kernel],
  );

  const selectDraftNode = useCallback(() => {
    if (!activeDraft) return;
    const nodeId = "model:definitions:planar-monitors:draft";
    kernel?.selection.set(
      {
        kind: "model.planar.monitor.draft",
        label: activeDraft.monitor.name,
        nodeId,
        objectId: null,
        ref: {
          draftId: "draft",
          kind: "model.planar.monitor.draft",
          nodeId,
          type: "planar-monitor-draft",
          visualizationTargetId: "planar-monitor:draft",
        },
      },
      "inspector",
    );
  }, [activeDraft, kernel]);

  const handleDiscardDraft = useCallback(() => {
    discardPlanarMonitorDraft();
    if (kernel) {
      void kernel.commands.execute(
        "planar-monitor.discard-draft",
        createCommandContext("inspector", kernel),
      );
    }
  }, [kernel]);

  const spec = useMemo<InspectorSpec<PlanarMonitorGeometryDraft>>(
    () => ({
      id: `model.planar.monitors:${selection.nodeId ?? "root"}`,
      header: {
        breadcrumbs: [
          { id: "model", label: "Model" },
          { id: "definitions", label: "Definitions" },
          { id: "monitors", label: "Planar Monitors" },
        ],
        ...(kernel
          ? {
              primaryHeaderAction: {
                label: "Add Planar Monitor",
                icon: Plus,
                onRun: runCreateMonitor,
              },
            }
          : {}),
      },
      identity: {
        domain: "definition",
        icon: Slice,
        title: () => "Planar Monitors",
        kindLabel: "2D cross-section field observation planes",
        statePill: () =>
          activeDraft
            ? { tone: "warn", label: "Draft active" }
            : {
                tone: monitors.length > 0 ? "ok" : "neutral",
                label: `${monitors.length} ${monitors.length === 1 ? "monitor" : "monitors"}`,
              },
      },
      facts: () => [
        { id: "count", label: "Committed", value: String(monitors.length) },
        {
          id: "draft",
          label: "Draft",
          value: activeDraft ? activeDraft.monitor.name : "None",
          ...(activeDraft ? { tone: "warn" as const } : {}),
        },
        ...(sceneRevision !== undefined
          ? [{ id: "rev", label: "Scene", value: `rev ${sceneRevision}` }]
          : [
              {
                id: "type",
                label: "Sampling",
                value: "2D planar cross-section",
              },
            ]),
      ],
      sections: [
        ...(activeDraft
          ? [
              {
                id: "active-planar-draft",
                title: "Active Unsaved Draft",
                icon: Compass,
                defaultOpen: true,
                rows: [
                  {
                    type: "custom" as const,
                    label: activeDraft.monitor.name,
                    wide: true,
                    render: () => (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-fm-border px-2.5 py-2 text-xs">
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {activeDraft.monitor.name} ({activeDraft.monitor.id})
                          </div>
                          <div className="text-fm-muted">
                            {(
                              activeDraft.monitor.frame.preset ?? "arbitrary"
                            ).toUpperCase()}{" "}
                            · {activeDraft.monitor.target.kind} ·{" "}
                            {activeDraft.monitor.operator.kind}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button
                            size="sm"
                            type="button"
                            variant="primary"
                            onClick={selectDraftNode}
                          >
                            Resume Draft
                          </Button>
                          <Button
                            size="sm"
                            type="button"
                            variant="ghost"
                            onClick={handleDiscardDraft}
                          >
                            Discard Draft
                          </Button>
                        </div>
                      </div>
                    ),
                  },
                ],
              },
            ]
          : []),
        {
          id: "monitors-overview",
          title: "Configured Cross-Section Planes",
          icon: Layers,
          defaultOpen: true,
          ...(kernel
            ? {
                footer: () => (
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() => void runCreateMonitor()}
                  >
                    <Plus aria-hidden="true" size={14} />
                    <span>New Planar Monitor</span>
                  </Button>
                ),
              }
            : {}),
          rows:
            monitors.length === 0
              ? [
                  {
                    type: "custom",
                    label: "Monitors",
                    wide: true,
                    render: () => (
                      <EmptyState
                        description="Create a planar monitor to slice 3D magnetization or stray fields onto an arbitrary 2D plane."
                        heading="Select or add a planar monitor"
                      />
                    ),
                  },
                ]
              : monitors.map((monitor) => ({
                  type: "custom" as const,
                  label: monitor.name,
                  wide: true,
                  render: () => (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-fm-border px-2.5 py-1.5 text-xs">
                      <Button
                        className="h-auto min-w-0 flex-1 justify-start px-1 py-0.5 text-left"
                        type="button"
                        variant="ghost"
                        onClick={() => selectMonitor(monitor)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">
                            {monitor.name}
                          </span>
                          <span className="block text-fm-muted">
                            {(monitor.frame.preset ?? "arbitrary").toUpperCase()}{" "}
                            · {monitor.target.kind} · {monitor.operator.kind}
                          </span>
                        </span>
                      </Button>
                      <div className="flex items-center gap-1.5">
                        <Button
                          aria-label={`Open ${monitor.name} in 2D view`}
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => openMonitorIn2D(monitor)}
                        >
                          <Eye aria-hidden="true" size={13} />
                          <span>Open 2D View</span>
                        </Button>
                        <Button
                          aria-label={`Inspect ${monitor.name}`}
                          size="sm"
                          type="button"
                          variant="secondary"
                          onClick={() => selectMonitor(monitor)}
                        >
                          Inspect
                        </Button>
                      </div>
                    </div>
                  ),
                })),
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [
      activeDraft,
      handleDiscardDraft,
      kernel,
      monitors,
      openMonitorIn2D,
      runCreateMonitor,
      sceneRevision,
      selectDraftNode,
      selectMonitor,
      selection.nodeId,
    ],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_PLANAR_GEOMETRY_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

/* ── 2. model.planar.monitor.draft — Unsaved Draft ──────────────────────── */

export function PlanarMonitorDraftTemplatePanel(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedPlanarMonitorDraftPanel {...props} />;
  }
  return <PlanarMonitorDraftFallbackView {...props} />;
}

function ConnectedPlanarMonitorDraftPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const definitionAvailability = useSafePlanarMonitorDefinitionAvailability();
  const monitors = usePlanarMonitorsResource();
  const visualizationState = useVisualizationStateResource();
  const workspaceDraft = useCrossSectionWorkspaceSelector(
    (state) => state.planarMonitorDraft,
  );
  const pickFaceArmed = usePlanarMonitorPickFaceArmed();

  const initialBaselineDraft = useMemo<PlanarMonitorDraft>(
    () =>
      planarMonitorDraftFromMonitor(
        createDefaultCanonicalMonitor("new_planar_monitor"),
      ),
    [],
  );

  const [localFallbackDraft, setLocalFallbackDraft] =
    useState<PlanarMonitorDraft>(initialBaselineDraft);
  const activeDraft = workspaceDraft ?? localFallbackDraft;
  const draftRef = useRef(activeDraft);
  useLayoutEffect(() => {
    draftRef.current = activeDraft;
  }, [activeDraft]);

  const [feedback, setFeedback] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [applying, setApplying] = useState(false);
  const [appliedFlash, setAppliedFlash] = useState(false);
  const [activeTabId, setActiveTabId] = useState<string>("definition");
  const [codePreview, setCodePreview] = useState<{
    title: string;
    code: string;
  } | null>(null);
  const applyInFlight = useRef(false);

  const handleDraftChange = useCallback((next: PlanarMonitorDraft) => {
    draftRef.current = next;
    setLocalFallbackDraft(next);
    updatePlanarMonitorDraft(next);
    setFeedback(null);
  }, []);

  // Publish live 3D frame preview and subscribe to 3D normal-handle gizmo edits.
  useEffect(() => {
    planarMonitorFramePreviewStore.setDraft(activeDraft);
    return () => planarMonitorFramePreviewStore.clearDraft();
  }, [activeDraft]);

  useEffect(
    () =>
      planarMonitorFramePreviewStore.registerDraftEditor({
        monitorId: activeDraft.monitor.id,
        proposeFrame: (frame) => {
          const current = draftRef.current;
          const next: PlanarMonitorDraft = {
            ...current,
            monitor: {
              ...current.monitor,
              frame: {
                ...current.monitor.frame,
                ...Object.fromEntries(
                  Object.entries(frame).map(([key, value]) => [
                    key,
                    [...value],
                  ]),
                ),
                ...(frame.normal || frame.u_axis || frame.v_axis
                  ? { preset: null }
                  : {}),
              },
            },
          };
          draftRef.current = next;
          setLocalFallbackDraft(next);
          updatePlanarMonitorDraft(next);
        },
      }),
    [activeDraft.monitor.id],
  );

  const validationErrors = useMemo(
    () => [
      ...planarMonitorValidationErrors(activeDraft.monitor),
      ...planarMonitorDefinitionAvailabilityErrors(
        activeDraft.monitor,
        definitionAvailability,
      ),
    ],
    [activeDraft.monitor, definitionAvailability],
  );

  const commitDraft = useCallback(async (): Promise<boolean> => {
    if (applyInFlight.current) return false;
    if (typeof kernel.api?.model?.planarMonitors?.create !== "function") {
      return false;
    }
    const currentDraft = draftRef.current;
    const activeCommandScopeKey = kernel.commands?.getSessionScopeKey?.();
    const operationSessionScopeKey =
      sessionScopeKey ??
      (typeof activeCommandScopeKey === "string"
        ? activeCommandScopeKey
        : null);
    if (!operationSessionScopeKey || activeCommandScopeKey === null) {
      setFeedback("Session identity is not ready. Try again after it loads.");
      return false;
    }
    if (validationErrors.length > 0) {
      setFeedback(validationErrors[0] ?? "Fix validation errors before creating.");
      return false;
    }

    const initialCommandScope =
      activeCommandScopeKey ?? operationSessionScopeKey;
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();
    const historyContext = {
      api: kernel.api,
      authoringHistory: kernel.authoringHistory,
      selection: kernel.selection,
      sessionScopeKey: operationSessionScopeKey,
      isCurrentSessionScope: () => {
        const currentCommandScope =
          typeof kernel.commands?.getSessionScopeKey === "function"
            ? kernel.commands.getSessionScopeKey()
            : operationSessionScopeKey;
        return (
          currentCommandScope !== null &&
          currentCommandScope === initialCommandScope &&
          (historyGeneration === undefined ||
            kernel.authoringHistory?.getGeneration?.() === historyGeneration)
        );
      },
    };

    const submittedDraft = currentDraft;
    applyInFlight.current = true;
    setApplying(true);
    setFeedback(null);
    setConflict(false);

    try {
      const existing = monitors.data?.monitors ?? [];
      const hasIdentityCollision = existing.some(
        (entry) =>
          entry.id === currentDraft.monitor.id ||
          entry.name === currentDraft.monitor.name,
      );
      const identity = hasIdentityCollision
        ? planarMonitorIdentityForCreate(currentDraft.monitor.name, existing)
        : { id: currentDraft.monitor.id, name: currentDraft.monitor.name };
      const draftWithIdentity: PlanarMonitorDraft = {
        ...currentDraft,
        monitor: { ...currentDraft.monitor, ...identity },
      };
      const fallbackRevision = monitors.data?.scene_revision ?? 1;

      const created = await runAuthoringMutationWithHistory(
        historyContext,
        "Create planar monitor",
        async ({ baseRevision }) => {
          const commitRevision = baseRevision ?? fallbackRevision;
          return kernel.api.model.planarMonitors.create(
            planarMonitorCreateRequestFromDraft(
              draftWithIdentity,
              commitRevision,
            ),
            { sessionScopeKey: operationSessionScopeKey },
          );
        },
      );

      if (historyContext.isCurrentSessionScope() === false) return false;

      const latestStoreDraft =
        crossSectionWorkspaceStore.getSnapshot().planarMonitorDraft;
      if (
        latestStoreDraft !== null &&
        workspaceDraft !== null &&
        latestStoreDraft !== submittedDraft
      ) {
        kernel.resources?.invalidate(
          MODEL_PLANAR_MONITORS_PATH,
          created.scene_revision,
        );
        setFeedback(
          "The monitor was created; newer monitor edits remain in the draft.",
        );
        return true;
      }

      discardPlanarMonitorDraft();
      kernel.visualizationSync?.queuePatch({
        planar: {
          source: { kind: "monitor", monitor_id: created.monitor.id },
        },
      });
      kernel.resources?.invalidate(
        MODEL_PLANAR_MONITORS_PATH,
        created.scene_revision,
      );
      const nodeId = `model:definitions:planar-monitors:${created.monitor.id}`;
      kernel.selection?.set(
        {
          kind: "model.planar.monitor",
          label: created.monitor.name,
          nodeId,
          objectId: null,
          ref: {
            kind: "model.planar.monitor",
            monitorId: created.monitor.id,
            nodeId,
            type: "planar-monitor",
            visualizationTargetId: `planar-monitor:${created.monitor.id}`,
          },
        },
        "inspector",
      );
      kernel.layout?.setActiveViewportMainModule?.("field-map");
      kernel.layout?.setFocusedSlot?.("viewport-main");
      kernel.layout?.setPanelVisible?.("right", true);
      setAppliedFlash(true);
      return true;
    } catch (error) {
      if (historyContext.isCurrentSessionScope() === false) return false;
      const revisionConflict = isPlanarMonitorRevisionConflict(error);
      setConflict(revisionConflict);
      setFeedback(
        revisionConflict
          ? "The scene changed while this monitor draft was open. Reload the current revision before applying again."
          : error instanceof Error
            ? error.message
            : "Planar monitor commit failed. Reload the scene and retry.",
      );
      return false;
    } finally {
      applyInFlight.current = false;
      setApplying(false);
    }
  }, [
    kernel,
    monitors.data,
    sessionScopeKey,
    validationErrors,
    workspaceDraft,
  ]);

  const handleDiscardDraft = useCallback(() => {
    discardPlanarMonitorDraft();
    setLocalFallbackDraft(initialBaselineDraft);
    setFeedback(null);
    setConflict(false);
    void kernel.commands?.execute?.(
      "planar-monitor.discard-draft",
      createCommandContext("inspector", kernel, {
        sourceDetail: "planar-monitor-draft-inspector",
      }),
    );
    kernel.selection?.set?.(
      {
        kind: "model.planar.monitors",
        label: "Planar Monitors",
        nodeId: "model:definitions:planar-monitors",
        objectId: null,
        ref: null,
      },
      "inspector",
    );
  }, [initialBaselineDraft, kernel]);

  const handleResetDisplay = useCallback(() => {
    kernel.visualizationSync?.queuePatch({ planar: defaultPlanarDisplayPatch() });
    void kernel.visualizationSync?.flushNow?.();
  }, [kernel.visualizationSync]);

  const templateDraft = useMemo(
    () => toTemplateDraft(activeDraft),
    [activeDraft],
  );
  const templateBaseline = useMemo(
    () => toTemplateDraft(initialBaselineDraft),
    [initialBaselineDraft],
  );

  // An unsaved draft is always unapplied relative to the canonical scene.
  const dirtyFields = useMemo<ReadonlySet<string>>(
    () => new Set(["monitor"]),
    [],
  );
  const invalidFields = useMemo<ReadonlyMap<string, string>>(() => {
    const map = new Map<string, string>();
    validationErrors.forEach((err, index) => {
      map.set(index === 0 ? "monitor" : `monitor_${index}`, err);
    });
    return map;
  }, [validationErrors]);

  const specId = `model.planar.monitor.draft:${selection.nodeId ?? "draft"}`;
  const sessionKey = formatInspectorSessionKey(
    selection.nodeId ?? "draft",
    specId,
    "definition",
  );
  const registeredSession = useMemo<InspectorEditSessionV2>(
    () => ({
      sessionKey,
      nodeTitle: activeDraft.monitor.name || "New Planar Monitor",
      mode: "staged",
      applying,
      dirty: workspaceDraft !== null,
      dirtyFields,
      dirtyFieldLabels: ["Planar monitor draft"],
      invalidFields,
      valid: invalidFields.size === 0 && !conflict,
      lockReason: conflict
        ? "The scene changed while this draft was open. Reload monitors before applying."
        : null,
      applyBlockReason: !sessionScopeKey ? "Session identity is not ready." : null,
      apply: commitDraft,
      revertAll: handleDiscardDraft,
      revertField: () => handleDiscardDraft(),
      focusField: () => undefined,
    }),
    [
      activeDraft.monitor.name,
      applying,
      commitDraft,
      conflict,
      dirtyFields,
      handleDiscardDraft,
      invalidFields,
      sessionKey,
      sessionScopeKey,
      workspaceDraft,
    ],
  );
  useRegisterInspectorEditSessionV2(registeredSession);

  const pickFaceButton = useMemo(
    () => (
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <Button
          aria-pressed={pickFaceArmed}
          size="sm"
          type="button"
          variant={pickFaceArmed ? "primary" : "secondary"}
          onClick={() =>
            planarMonitorFramePreviewStore.setPickFaceArmed(!pickFaceArmed)
          }
        >
          <Crosshair aria-hidden="true" size={13} />
          <span>Pick face in 3D</span>
        </Button>
      </div>
    ),
    [pickFaceArmed],
  );

  const spec = useMemo<InspectorSpec<PlanarMonitorTemplateDraft>>(
    () => ({
      id: specId,
      header: {
        breadcrumbs: [
          { id: "model", label: "Model" },
          {
            id: "monitors",
            label: "Planar Monitors",
            selection: {
              kind: "model.planar.monitors",
              label: "Planar Monitors",
              nodeId: "model:definitions:planar-monitors",
              objectId: null,
              ref: null,
            },
          },
          { id: "draft", label: "New Planar Monitor" },
        ],
        primaryHeaderAction: {
          label: "Discard Draft",
          icon: Trash2,
          variant: "secondary",
          onRun: handleDiscardDraft,
        },
      },
      identity: {
        domain: "definition",
        icon: Slice,
        title: (d) => d.monitor.name || "New Planar Monitor",
        renameFieldKey: "name",
        kindLabel: "Unsaved planar monitor draft",
        entityId: activeDraft.monitor.id,
        statePill: () => ({ tone: "warn", label: "Draft" }),
      },
      facts: (d) => [
        {
          id: "plane",
          label: "Frame",
          value: (d.monitor.frame.preset ?? "arbitrary").toUpperCase(),
        },
        { id: "target", label: "Target", value: d.monitor.target.kind },
        { id: "operator", label: "Operator", value: d.monitor.operator.kind },
      ],
      modeTabs: [
        { id: "definition", label: "Definition" },
        {
          id: "display",
          label: "2D Display",
          commitModeOverride: "liveViewport",
        },
      ],
      notices: () => {
        const items: InspectorNotice<PlanarMonitorTemplateDraft>[] = [];
        if (conflict) {
          items.push({
            id: "draft-conflict",
            tone: "err",
            title: "Scene revision conflict",
            text:
              feedback ??
              "The scene changed while this monitor draft was open.",
            quickFix: {
              label: "Reload current monitors",
              onApply: () => {
                monitors.refetch?.();
                setConflict(false);
                setFeedback(null);
              },
            },
          });
        } else if (feedback) {
          items.push({
            id: "draft-feedback",
            tone: "err",
            text: feedback,
          });
        }
        for (const err of [...new Set(validationErrors)]) {
          items.push({
            id: `val-${err}`,
            tone: "warn",
            text: err,
          });
        }
        return items;
      },
      sections: [
        {
          id: "draft-definition",
          title: "Monitor Definition",
          icon: Compass,
          modeTabId: "definition",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Planar monitor definition",
              wide: true,
              render: () => (
                <div className="grid min-w-0 gap-3">
                  <PlanarMonitorDefinitionEditor
                    availability={definitionAvailability}
                    draft={activeDraft}
                    mode="create"
                    pickFaceSlot={pickFaceButton}
                    onChange={handleDraftChange}
                  />
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      disabled={
                        applying || conflict || validationErrors.length > 0
                      }
                      size="sm"
                      type="button"
                      variant="primary"
                      onClick={() => void commitDraft()}
                    >
                      Create Monitor
                    </Button>
                    <Button
                      disabled={applying}
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={handleDiscardDraft}
                    >
                      Discard Draft
                    </Button>
                  </div>
                </div>
              ),
            },
          ],
        },
        {
          id: "draft-2d-display",
          title: "2D Slice Display",
          icon: Palette,
          modeTabId: "display",
          live: true,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "2D display",
              wide: true,
              render: () => (
                <ConnectedPlanar2DDisplayBody
                  monitorId={activeDraft.monitor.id}
                  selection={selection}
                />
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        lockReason: () =>
          conflict
            ? "Reload current monitors before creating."
            : null,
        onApply: async () => commitDraft(),
        onRevert: () => handleDiscardDraft(),
      },
    }),
    [
      activeDraft,
      applying,
      commitDraft,
      conflict,
      definitionAvailability,
      feedback,
      handleDiscardDraft,
      handleDraftChange,
      monitors,
      pickFaceButton,
      selection,
      specId,
      validationErrors,
    ],
  );

  const hasDisplayOverrides = Boolean(
    visualizationState.data?.planar &&
      planarDisplayDiffersFromDefault(visualizationState.data.planar),
  );

  return (
    <>
      <InspectorTemplate<PlanarMonitorTemplateDraft>
        activeModeTabId={activeTabId}
        appliedFlash={appliedFlash}
        applyError={feedback}
        applying={applying}
        baseline={templateBaseline}
        dirtyFields={dirtyFields}
        draft={templateDraft}
        invalidFields={invalidFields}
        selection={selection}
        spec={spec}
        touchedFields={EMPTY_SET}
        onActiveModeTabChange={setActiveTabId}
        onApply={commitDraft}
        onFieldChange={(key, value) => {
          if (key === "name" && typeof value === "string") {
            handleDraftChange({
              ...activeDraft,
              monitor: { ...activeDraft.monitor, name: value },
            });
          }
        }}
        onFieldTouch={() => undefined}
        onOpenCodePreview={(title, _lang, code) =>
          setCodePreview({ title, code })
        }
        onResetDisplay={hasDisplayOverrides ? handleResetDisplay : handleResetDisplay}
        onRevertAll={handleDiscardDraft}
        onRevertField={() => handleDiscardDraft()}
        onSelectNode={(next) => kernel.selection?.set(next, "inspector")}
      />
      <CodePreviewDialog
        codePreview={codePreview}
        onClose={() => setCodePreview(null)}
      />
    </>
  );
}

function PlanarMonitorDraftFallbackView({ selection }: InspectorPanelProps) {
  const [localBaseline, setLocalBaseline] =
    useState<PlanarMonitorGeometryDraft>({
      ...DEFAULT_PLANAR_GEOMETRY_DRAFT,
      name: "new_planar_monitor",
    });

  const spec = useMemo<InspectorSpec<PlanarMonitorGeometryDraft>>(
    () => ({
      id: `model.planar.monitor.draft:${selection.nodeId ?? "draft"}`,
      header: {
        breadcrumbs: [
          { id: "model", label: "Model" },
          { id: "monitors", label: "Planar Monitors" },
          { id: "draft", label: "New Planar Monitor" },
        ],
      },
      identity: {
        domain: "definition",
        icon: Slice,
        title: (d) => d.name || "New Planar Monitor",
        renameFieldKey: "name",
        kindLabel: "Unsaved planar monitor draft",
        statePill: () => ({ tone: "warn", label: "Draft" }),
      },
      facts: (d) => [
        {
          id: "plane",
          label: "Orientation",
          value: d.normalPreset.toUpperCase(),
        },
        { id: "grid", label: "Grid", value: `${d.samplesU} x ${d.samplesV}` },
      ],
      sections: [
        {
          id: "draft-frame",
          title: "Plane Geometry & Resolution",
          icon: Compass,
          defaultOpen: true,
          rows: [
            {
              type: "segmented",
              key: "normalPreset",
              label: "Plane orientation",
              structural: true,
              options: [
                { value: "xy", label: "XY (+z)" },
                { value: "xz", label: "XZ (+y)" },
                { value: "yz", label: "YZ (+x)" },
                { value: "custom", label: "Custom" },
              ],
            },
            {
              type: "quantity",
              key: "planeOffsetM",
              label: "Plane offset",
              units: LENGTH_UNITS_SI,
              defaultDisplayUnit: "nm",
            },
            {
              type: "number",
              key: "samplesU",
              label: "Samples along U",
              integer: true,
              min: 4,
              max: 2048,
            },
            {
              type: "number",
              key: "samplesV",
              label: "Samples along V",
              integer: true,
              min: 4,
              max: 2048,
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (d) => {
          setLocalBaseline(d);
          return true;
        },
      },
    }),
    [selection.nodeId],
  );

  return (
    <ConnectedInspectorSpec
      baseline={localBaseline}
      selection={selection}
      spec={spec}
    />
  );
}

/* ── 3. model.planar.monitor — Committed Monitor (Definition + 2D Display) ─ */

export function PlanarMonitorTemplatePanel(props: InspectorPanelProps) {
  const kernel = useContext(KernelContext);
  if (kernel) {
    return <ConnectedPlanarMonitorPanel {...props} />;
  }
  return <PlanarMonitorFallbackView {...props} />;
}

function ConnectedPlanarMonitorPanel({ selection }: InspectorPanelProps) {
  const definitionAvailability = useSafePlanarMonitorDefinitionAvailability();
  const monitorId =
    selection.ref?.type === "planar-monitor"
      ? selection.ref.monitorId
      : (selection.nodeId?.split(":").at(-1) ?? "xy_midplane");
  const resource = usePlanarMonitorResource(monitorId, {
    enabled: monitorId.length > 0,
  });
  const monitor = resource.data?.monitor;
  const sceneRevision = resource.data?.scene_revision;

  if (!monitor || sceneRevision === undefined) {
    return (
      <PlanarMonitorResourceLoadingView
        error={resource.status === "error"}
        monitorId={monitorId}
        selection={selection}
        onRetry={resource.refetch}
      />
    );
  }

  return (
    <CommittedPlanarMonitorTemplateEditor
      key={monitor.id}
      definitionAvailability={definitionAvailability}
      monitor={monitor}
      refetch={resource.refetch}
      sceneRevision={sceneRevision}
      selection={selection}
    />
  );
}

function PlanarMonitorResourceLoadingView({
  error,
  monitorId,
  onRetry,
  selection,
}: {
  error: boolean;
  monitorId: string;
  onRetry?: () => void;
  selection: Selection;
}) {
  const spec = useMemo<InspectorSpec<PlanarMonitorGeometryDraft>>(
    () => ({
      id: `model.planar.monitor:loading:${monitorId}`,
      header: {
        breadcrumbs: [
          { id: "model", label: "Model" },
          { id: "monitors", label: "Planar Monitors" },
          { id: monitorId, label: selection.label || monitorId },
        ],
      },
      identity: {
        domain: "definition",
        icon: Slice,
        title: () => selection.label || monitorId || "Planar Monitor",
        kindLabel: "Committed 2D planar monitor",
        entityId: monitorId || undefined,
        statePill: () =>
          error
            ? { tone: "err", label: "Load failed" }
            : { tone: "neutral", label: "Loading" },
      },
      facts: () => [],
      sections: [
        {
          id: "monitor-resource-state",
          title: "Monitor Resource",
          icon: Compass,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Status",
              wide: true,
              render: () => (
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-fm-muted">
                    {error
                      ? "The planar monitor resource could not be loaded."
                      : "Loading committed planar monitor definition…"}
                  </span>
                  {error && onRetry ? (
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      onClick={onRetry}
                    >
                      <RotateCcw aria-hidden="true" size={13} />
                      <span>Retry</span>
                    </Button>
                  ) : null}
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: { mode: "readOnly" },
    }),
    [error, monitorId, onRetry, selection.label],
  );

  return (
    <ConnectedInspectorSpec
      baseline={DEFAULT_PLANAR_GEOMETRY_DRAFT}
      selection={selection}
      spec={spec}
    />
  );
}

function CommittedPlanarMonitorTemplateEditor({
  definitionAvailability,
  monitor,
  refetch,
  sceneRevision,
  selection,
}: {
  definitionAvailability: PlanarMonitorDefinitionAvailability;
  monitor: PlanarMonitor;
  refetch?: () => void;
  sceneRevision: number;
  selection: Selection;
}) {
  const kernel = useKernel();
  const sessionScopeKey = sessionRequestScopeKey(useSessionResourceIdentity());
  const visualizationState = useVisualizationStateResource();
  const pickFaceArmed = usePlanarMonitorPickFaceArmed();

  const [acknowledgedBaseline, setAcknowledgedBaseline] = useState<{
    monitor: PlanarMonitor;
    revision: number;
  }>({ monitor, revision: sceneRevision });
  const [baselineState, setBaselineState] = useState({
    monitor,
    revision: sceneRevision,
  });

  const baseline =
    acknowledgedBaseline.revision > sceneRevision
      ? acknowledgedBaseline
      : baselineState.revision > sceneRevision
        ? baselineState
        : { monitor, revision: sceneRevision };

  const [draft, setDraft] = useState<PlanarMonitorDraft>(() =>
    planarMonitorDraftFromMonitor(monitor),
  );

  const [feedback, setFeedback] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [applying, setApplying] = useState(false);
  const [commandPending, setCommandPending] = useState(false);
  const [appliedFlash, setAppliedFlash] = useState(false);
  const [activeTabId, setActiveTabId] = useState<string>("definition");
  const [codePreview, setCodePreview] = useState<{
    title: string;
    code: string;
  } | null>(null);

  // Reconcile external resource refreshes while preserving clean inputs or flagging conflicts.
  const previousDefinition = JSON.stringify(baselineState.monitor);
  const definitionChanged = JSON.stringify(monitor) !== previousDefinition;
  if (
    sceneRevision > acknowledgedBaseline.revision &&
    (sceneRevision !== baselineState.revision || definitionChanged)
  ) {
    setBaselineState({ monitor, revision: sceneRevision });
    if (JSON.stringify(draft.monitor) === previousDefinition) {
      setDraft(
        planarMonitorDraftFromMonitor(monitor, draft.ui.displayLengthUnit),
      );
    } else if (definitionChanged) {
      setConflict(true);
      setFeedback(
        "The monitor definition changed externally while this draft was open. Revert to the current monitor before applying.",
      );
    }
  }

  const errors = useMemo(
    () => [
      ...planarMonitorValidationErrors(draft.monitor),
      ...(draft.monitor.id === monitor.id
        ? []
        : ["Committed monitor ID must match the resource path ID."]),
      ...planarMonitorDefinitionAvailabilityErrors(
        draft.monitor,
        definitionAvailability,
      ),
    ],
    [definitionAvailability, draft.monitor, monitor.id],
  );

  const dirty =
    JSON.stringify(draft.monitor) !== JSON.stringify(baseline.monitor);
  const pending = applying || commandPending;

  const updateDraft = useCallback((next: PlanarMonitorDraft) => {
    setDraft(next);
    setAppliedFlash(false);
  }, []);

  // Publish live 3D frame preview when dirty and register 3D normal-handle gizmo editor.
  useEffect(() => {
    planarMonitorFramePreviewStore.setDraft(dirty ? draft : null);
    return () => planarMonitorFramePreviewStore.clearDraft();
  }, [dirty, draft]);

  useEffect(
    () =>
      planarMonitorFramePreviewStore.registerDraftEditor({
        monitorId: monitor.id,
        proposeFrame: (frame) => {
          setDraft((current) => ({
            ...current,
            monitor: {
              ...current.monitor,
              frame: {
                ...current.monitor.frame,
                ...Object.fromEntries(
                  Object.entries(frame).map(([key, value]) => [
                    key,
                    [...value],
                  ]),
                ),
                ...(frame.normal || frame.u_axis || frame.v_axis
                  ? { preset: null }
                  : {}),
              },
            },
          }));
        },
      }),
    [monitor.id],
  );

  const runMonitorCommand = useCallback(
    (commandId: CommandId, extraInput?: Record<string, unknown>) =>
      kernel.commands.execute(
        commandId,
        createCommandContext("inspector", kernel, {
          resourceData: {
            [VISUALIZATION_STATE_PATH]: visualizationState.data,
          },
          sourceDetail: "planar-monitor-inspector",
        }),
        { monitorId: monitor.id, ...extraInput },
      ),
    [kernel, monitor.id, visualizationState.data],
  );

  const resetDraft = useCallback(() => {
    setDraft((current) =>
      planarMonitorDraftFromMonitor(
        baseline.monitor,
        current.ui.displayLengthUnit,
      ),
    );
    setFeedback(null);
    setConflict(false);
    setAppliedFlash(false);
  }, [baseline.monitor]);

  const apply = useCallback(async (): Promise<boolean> => {
    if (applying || conflict || !dirty || errors.length > 0) {
      return false;
    }
    if (typeof kernel.api?.model?.planarMonitors?.patch !== "function") {
      return false;
    }
    const activeCommandScopeKey = kernel.commands?.getSessionScopeKey?.();
    const operationSessionScopeKey =
      sessionScopeKey ??
      (typeof activeCommandScopeKey === "string"
        ? activeCommandScopeKey
        : null);
    if (!operationSessionScopeKey || activeCommandScopeKey === null) {
      setFeedback("Session identity is not ready. Try again after it loads.");
      return false;
    }

    const submittedDraft = draft;
    const submittedMonitor = structuredClone(submittedDraft.monitor);
    const initialCommandScope =
      activeCommandScopeKey ?? operationSessionScopeKey;
    const historyGeneration = kernel.authoringHistory?.getGeneration?.();

    const historyContext = {
      ...createCommandContext("inspector", kernel, {
        resourceData: {
          [VISUALIZATION_STATE_PATH]: visualizationState.data,
        },
        sessionScopeKey: operationSessionScopeKey,
        sourceDetail: "planar-monitor-inspector",
      }),
      isCurrentSessionScope: () => {
        const currentCommandScope =
          typeof kernel.commands?.getSessionScopeKey === "function"
            ? kernel.commands.getSessionScopeKey()
            : operationSessionScopeKey;
        return (
          currentCommandScope !== null &&
          currentCommandScope === initialCommandScope &&
          (historyGeneration === undefined ||
            kernel.authoringHistory?.getGeneration?.() === historyGeneration)
        );
      },
    };

    setApplying(true);
    setFeedback(null);
    setConflict(false);

    try {
      const response = await runAuthoringMutationWithHistory(
        historyContext,
        "Update planar monitor",
        async ({ baseRevision }) => {
          const commitRevision = baseRevision ?? baseline.revision;
          if (
            typeof commitRevision !== "number" ||
            !Number.isFinite(commitRevision)
          ) {
            throw new Error(
              "The canonical scene revision is unavailable. Refetch the scene before applying.",
            );
          }
          const writeOptions = authoringWriteOptions(
            commitRevision,
            operationSessionScopeKey,
          );
          if (
            !writeOptions?.sessionScopeKey ||
            writeOptions.baseRevision === undefined
          ) {
            throw new Error(
              "The session-scoped scene revision is unavailable. Refetch the scene before applying.",
            );
          }
          return kernel.api.model.planarMonitors.patch(
            monitor.id,
            {
              expected_scene_revision: writeOptions.baseRevision,
              monitor: submittedMonitor,
            },
            writeOptions,
          );
        },
      );

      if (historyContext.isCurrentSessionScope() === false) return false;

      const nextBaseline = {
        monitor: response.monitor,
        revision: response.scene_revision,
      };
      setBaselineState(nextBaseline);
      setAcknowledgedBaseline(nextBaseline);
      setDraft((current) =>
        current === submittedDraft
          ? planarMonitorDraftFromMonitor(
              response.monitor,
              submittedDraft.ui.displayLengthUnit,
            )
          : current,
      );
      kernel.resources?.invalidate(
        MODEL_PLANAR_MONITORS_PATH,
        response.scene_revision,
      );
      refetch?.();
      setAppliedFlash(true);
      return true;
    } catch (error) {
      if (historyContext.isCurrentSessionScope() === false) return false;
      const revisionConflict = isPlanarMonitorRevisionConflict(error);
      setConflict(revisionConflict);
      setFeedback(
        revisionConflict
          ? "The scene changed while this monitor was being edited. Reload the current revision before applying again."
          : error instanceof Error
            ? error.message
            : "Planar monitor update failed.",
      );
      return false;
    } finally {
      setApplying(false);
    }
  }, [
    applying,
    baseline.revision,
    conflict,
    dirty,
    draft,
    errors.length,
    kernel,
    monitor.id,
    refetch,
    sessionScopeKey,
    visualizationState.data,
  ]);

  const duplicate = useCallback(async () => {
    setCommandPending(true);
    setFeedback(null);
    try {
      const result = await runMonitorCommand("planar-monitor.duplicate");
      if (result.status === "failed") {
        setFeedback(result.message ?? "Planar monitor duplication failed.");
      }
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "Planar monitor duplication failed.",
      );
    } finally {
      setCommandPending(false);
    }
  }, [runMonitorCommand]);

  const handleResetDisplay = useCallback(() => {
    kernel.visualizationSync?.queuePatch({ planar: defaultPlanarDisplayPatch() });
    void kernel.visualizationSync?.flushNow?.();
  }, [kernel.visualizationSync]);

  const dirtyFields = useMemo<ReadonlySet<string>>(() => {
    const next = new Set<string>();
    if (!dirty) return next;
    if (draft.monitor.name !== baseline.monitor.name) next.add("name");
    if (
      JSON.stringify(draft.monitor.target) !==
      JSON.stringify(baseline.monitor.target)
    ) {
      next.add("target");
    }
    if (
      JSON.stringify(draft.monitor.frame) !==
      JSON.stringify(baseline.monitor.frame)
    ) {
      next.add("frame");
    }
    if (
      JSON.stringify(draft.monitor.operator) !==
      JSON.stringify(baseline.monitor.operator)
    ) {
      next.add("operator");
    }
    if (next.size === 0) next.add("monitor");
    return next;
  }, [baseline.monitor, dirty, draft.monitor]);

  const invalidFields = useMemo<ReadonlyMap<string, string>>(() => {
    const map = new Map<string, string>();
    errors.forEach((err, index) => {
      map.set(index === 0 ? "monitor" : `monitor_${index}`, err);
    });
    return map;
  }, [errors]);

  const specId = `model.planar.monitor:${monitor.id}`;
  const sessionKey = formatInspectorSessionKey(
    selection.nodeId ?? monitor.id,
    specId,
    "definition",
  );
  const registeredSession = useMemo<InspectorEditSessionV2>(
    () => ({
      sessionKey,
      nodeTitle: draft.monitor.name || monitor.id,
      mode: "staged",
      applying,
      dirty,
      dirtyFields,
      dirtyFieldLabels: Array.from(dirtyFields),
      invalidFields,
      valid: errors.length === 0 && !conflict,
      lockReason: conflict
        ? "The monitor definition changed externally. Revert this draft before applying."
        : null,
      applyBlockReason: conflict
        ? "The monitor definition changed externally. Revert this draft before applying."
        : sessionScopeKey
          ? null
          : "Session identity is not ready.",
      apply,
      revertAll: resetDraft,
      revertField: () => resetDraft(),
      focusField: () => setActiveTabId("definition"),
    }),
    [
      apply,
      applying,
      conflict,
      dirty,
      dirtyFields,
      draft.monitor.name,
      errors.length,
      invalidFields,
      monitor.id,
      resetDraft,
      sessionKey,
      sessionScopeKey,
    ],
  );
  useRegisterInspectorEditSessionV2(registeredSession);

  const templateDraft = useMemo(() => toTemplateDraft(draft), [draft]);
  const templateBaseline = useMemo(
    () =>
      toTemplateDraft(
        planarMonitorDraftFromMonitor(
          baseline.monitor,
          draft.ui.displayLengthUnit,
        ),
      ),
    [baseline.monitor, draft.ui.displayLengthUnit],
  );

  const pickFaceButton = useMemo(
    () => (
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <Button
          aria-pressed={pickFaceArmed}
          size="sm"
          type="button"
          variant={pickFaceArmed ? "primary" : "secondary"}
          onClick={() =>
            planarMonitorFramePreviewStore.setPickFaceArmed(!pickFaceArmed)
          }
        >
          <Crosshair aria-hidden="true" size={13} />
          <span>Pick face in 3D</span>
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => void runMonitorCommand("planar-monitor.show-frame-3d")}
        >
          <Box aria-hidden="true" size={13} />
          <span>Show frame in 3D</span>
        </Button>
      </div>
    ),
    [pickFaceArmed, runMonitorCommand],
  );

  const spec = useMemo<InspectorSpec<PlanarMonitorTemplateDraft>>(
    () => ({
      id: specId,
      header: {
        breadcrumbs: [
          { id: "model", label: "Model" },
          {
            id: "monitors",
            label: "Planar Monitors",
            selection: {
              kind: "model.planar.monitors",
              label: "Planar Monitors",
              nodeId: "model:definitions:planar-monitors",
              objectId: null,
              ref: null,
            },
          },
          { id: monitor.id, label: draft.monitor.name || monitor.id },
        ],
        canFitView: true,
        fitCommandId: "planar-monitor.show-frame-3d",
        searchable: true,
        primaryHeaderAction: {
          label: "Open 2D View",
          icon: Eye,
          onRun: () => {
            void runMonitorCommand("field-map.select-monitor");
          },
        },
        extraMenuActions: [
          {
            id: "show-frame-3d",
            label: "Show frame in 3D",
            icon: Box,
            onSelect: () => {
              void runMonitorCommand("planar-monitor.show-frame-3d");
            },
          },
          {
            id: "duplicate-monitor",
            label: "Duplicate",
            icon: Copy,
            disabledReason: !visualizationState.data?.planar
              ? "Planar visualization state is loading."
              : undefined,
            onSelect: () => duplicate(),
          },
          {
            id: "create-preset",
            label: "Create preset",
            icon: Plus,
            onSelect: () => {
              void runMonitorCommand("planar-monitor.create", {
                intent: { source: "inspector" },
              });
            },
          },
        ],
        deleteAction: {
          label: "Delete",
          confirmTitle: (d) => `Delete planar monitor "${d.monitor.name}"?`,
          confirmDescription:
            "This removes the planar monitor definition from the canonical scene.",
          onDelete: async () => {
            await runMonitorCommand("planar-monitor.delete");
          },
        },
      },
      identity: {
        domain: "definition",
        icon: Slice,
        title: (d) => d.monitor.name || monitor.id,
        renameFieldKey: "name",
        kindLabel: "Committed 2D planar monitor",
        entityId: monitor.id,
        statePill: () =>
          conflict
            ? { tone: "err", label: "Conflict" }
            : dirty
              ? { tone: "warn", label: "Edited" }
              : { tone: "ok", label: "Committed" },
      },
      facts: (d) => [
        {
          id: "plane",
          label: "Frame",
          value: (d.monitor.frame.preset ?? "arbitrary").toUpperCase(),
        },
        {
          id: "offset",
          label: "Origin",
          value: formatMonitorOriginOffsetSummary(d.monitor),
        },
        { id: "target", label: "Target", value: d.monitor.target.kind },
        { id: "operator", label: "Operator", value: d.monitor.operator.kind },
      ],
      modeTabs: [
        { id: "definition", label: "Definition" },
        {
          id: "display",
          label: "2D Display",
          commitModeOverride: "liveViewport",
        },
      ],
      notices: () => {
        const items: InspectorNotice<PlanarMonitorTemplateDraft>[] = [];
        if (conflict) {
          items.push({
            id: "monitor-conflict",
            tone: "err",
            title: "External scene revision change",
            text:
              feedback ??
              "The monitor definition changed externally while this draft was open.",
            quickFix: {
              label: "Reload current monitor",
              onApply: () => {
                refetch?.();
                resetDraft();
              },
            },
          });
        } else if (feedback) {
          items.push({
            id: "monitor-feedback",
            tone: "err",
            text: feedback,
          });
        }
        for (const err of [...new Set(errors)]) {
          items.push({
            id: `val-${err}`,
            tone: "warn",
            text: err,
          });
        }
        return items;
      },
      sections: [
        {
          id: "plane-definition",
          title: "Monitor Definition",
          icon: Compass,
          modeTabId: "definition",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Planar monitor definition",
              wide: true,
              render: () => (
                <PlanarMonitorDefinitionEditor
                  availability={definitionAvailability}
                  draft={draft}
                  mode="committed"
                  pickFaceSlot={pickFaceButton}
                  onChange={updateDraft}
                />
              ),
            },
          ],
        },
        {
          id: "monitor-actions",
          title: "Monitor Actions",
          icon: Layers,
          modeTabId: "definition",
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "Actions",
              wide: true,
              render: () => (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void runMonitorCommand("field-map.select-monitor")
                    }
                  >
                    Open 2D View
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void runMonitorCommand("planar-monitor.create", {
                        intent: { source: "inspector" },
                      })
                    }
                  >
                    Create preset
                  </Button>
                  <Button
                    disabled={pending || !visualizationState.data?.planar}
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => void duplicate()}
                  >
                    Duplicate
                  </Button>
                  <Button
                    disabled={pending}
                    size="sm"
                    type="button"
                    variant="danger"
                    onClick={() =>
                      void runMonitorCommand("planar-monitor.delete")
                    }
                  >
                    Delete
                  </Button>
                </div>
              ),
            },
          ],
        },
        {
          id: "planar-2d-display",
          title: "2D Display & Field Layers",
          icon: Palette,
          modeTabId: "display",
          live: true,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "2D viewport preferences",
              wide: true,
              render: () => (
                <ConnectedPlanar2DDisplayBody
                  monitorId={monitor.id}
                  selection={selection}
                />
              ),
            },
          ],
        },
      ],
      details: () => [
        { label: "Monitor ID", value: monitor.id, mono: true },
        { label: "Scene revision", value: String(sceneRevision) },
        { label: "Source", value: "SceneDocument / ProblemIR" },
      ],
      commitBar: {
        mode: "staged",
        lockReason: () =>
          conflict
            ? "The monitor definition changed externally. Revert or reload before applying."
            : null,
        onApply: async () => apply(),
        onRevert: () => resetDraft(),
      },
    }),
    [
      apply,
      conflict,
      definitionAvailability,
      dirty,
      draft,
      duplicate,
      errors,
      feedback,
      monitor.id,
      pending,
      pickFaceButton,
      refetch,
      resetDraft,
      runMonitorCommand,
      sceneRevision,
      selection,
      specId,
      updateDraft,
      visualizationState.data?.planar,
    ],
  );

  const handleFitView = useCallback(
    (commandId?: CommandId) => {
      if (commandId === "planar-monitor.show-frame-3d") {
        void runMonitorCommand("planar-monitor.show-frame-3d");
        return;
      }
      const activeModuleId = (
        kernel.layout as { get?: () => { activeViewportMainModuleId: string } }
      )?.get?.()?.activeViewportMainModuleId;
      const resolvedId =
        commandId ??
        (activeModuleId
          ? inspectorFitCommandId(activeModuleId)
          : "field-map.fit");
      void kernel.commands.execute(
        resolvedId,
        createCommandContext("inspector", kernel),
      );
    },
    [kernel, runMonitorCommand],
  );

  return (
    <>
      <InspectorTemplate<PlanarMonitorTemplateDraft>
        activeModeTabId={activeTabId}
        appliedFlash={appliedFlash}
        applyError={feedback}
        applying={applying}
        baseline={templateBaseline}
        dirtyFields={dirtyFields}
        draft={templateDraft}
        invalidFields={invalidFields}
        selection={selection}
        spec={spec}
        touchedFields={EMPTY_SET}
        onActiveModeTabChange={setActiveTabId}
        onApply={apply}
        onFieldChange={(key, value) => {
          if (key === "name" && typeof value === "string") {
            updateDraft({
              ...draft,
              monitor: { ...draft.monitor, name: value },
            });
          }
        }}
        onFieldTouch={() => undefined}
        onFitView={handleFitView}
        onHideInspector={() => {
          void kernel.commands.execute(
            "panels:inspector:toggle",
            createCommandContext("inspector", kernel),
          );
        }}
        onOpenCodePreview={(title, _lang, code) =>
          setCodePreview({ title, code })
        }
        onResetDisplay={handleResetDisplay}
        onRevertAll={resetDraft}
        onRevertField={(fieldKey) => {
          if (fieldKey === "name") {
            updateDraft({
              ...draft,
              monitor: { ...draft.monitor, name: baseline.monitor.name },
            });
          } else {
            resetDraft();
          }
        }}
        onSelectNode={(next) => kernel.selection?.set(next, "inspector")}
      />
      <CodePreviewDialog
        codePreview={codePreview}
        onClose={() => setCodePreview(null)}
      />
    </>
  );
}

function CodePreviewDialog({
  codePreview,
  onClose,
}: {
  codePreview: { title: string; code: string } | null;
  onClose: () => void;
}): ReactNode {
  return (
    <Dialog
      open={codePreview !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{codePreview?.title ?? "Python DSL"}</DialogTitle>
          <DialogDescription>
            Equivalent Fullmag Python authoring snippet for the current draft.
          </DialogDescription>
        </DialogHeader>
        <pre className="fm-inspector-code-preview">
          <code>{codePreview?.code ?? ""}</code>
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function PlanarMonitorFallbackView({ selection }: InspectorPanelProps) {
  const monitorId =
    selection.ref?.type === "planar-monitor"
      ? selection.ref.monitorId
      : (selection.nodeId ?? "xy_midplane");

  const [localBaseline, setLocalBaseline] =
    useState<PlanarMonitorGeometryDraft>(() => ({
      ...DEFAULT_PLANAR_GEOMETRY_DRAFT,
      name:
        selection.label && selection.label !== "model.planar.monitor"
          ? selection.label
          : monitorId,
    }));

  const [displayState, setDisplayState] = useState<PlanarDisplayViewportState>(
    DEFAULT_PLANAR_DISPLAY,
  );

  const spec = useMemo<InspectorSpec<PlanarMonitorGeometryDraft>>(
    () => ({
      id: `model.planar.monitor:${monitorId}`,
      header: {
        breadcrumbs: [
          { id: "model", label: "Model" },
          { id: "monitors", label: "Planar Monitors" },
          { id: monitorId, label: localBaseline.name },
        ],
        canFitView: true,
        searchable: true,
      },
      identity: {
        domain: "definition",
        icon: Slice,
        title: (d) => d.name || monitorId,
        renameFieldKey: "name",
        kindLabel: "Committed 2D planar monitor",
        entityId: monitorId,
        statePill: () => ({ tone: "ok", label: "Committed" }),
      },
      facts: (d) => [
        { id: "plane", label: "Plane", value: d.normalPreset.toUpperCase() },
        {
          id: "offset",
          label: "Offset",
          value: `${(d.planeOffsetM * 1e9).toFixed(1)} nm`,
        },
        { id: "res", label: "Grid", value: `${d.samplesU} x ${d.samplesV}` },
      ],
      modeTabs: [
        { id: "definition", label: "Definition" },
        {
          id: "display",
          label: "2D Display",
          commitModeOverride: "liveViewport",
        },
      ],
      sections: [
        {
          id: "plane-definition",
          title: "Plane Frame & Sampling Grid",
          icon: Compass,
          modeTabId: "definition",
          defaultOpen: true,
          rows: [
            {
              type: "segmented",
              key: "normalPreset",
              label: "Plane orientation",
              structural: true,
              options: [
                { value: "xy", label: "XY (+z)" },
                { value: "xz", label: "XZ (+y)" },
                { value: "yz", label: "YZ (+x)" },
                { value: "custom", label: "Custom" },
              ],
            },
            {
              type: "quantity",
              key: "planeOffsetM",
              label: "Plane offset",
              units: LENGTH_UNITS_SI,
              defaultDisplayUnit: "nm",
            },
            {
              type: "vector3",
              key: "normalVector",
              label: "Plane normal",
              normalizeAction: true,
              showWhen: (d) => d.normalPreset === "custom",
            },
            {
              type: "number",
              key: "samplesU",
              label: "Samples along U",
              integer: true,
              min: 4,
              max: 2048,
            },
            {
              type: "number",
              key: "samplesV",
              label: "Samples along V",
              integer: true,
              min: 4,
              max: 2048,
            },
          ],
        },
        {
          id: "planar-2d-display",
          title: "2D Slice Colormap & Arrows",
          icon: Palette,
          modeTabId: "display",
          live: true,
          defaultOpen: true,
          rows: [
            {
              type: "custom",
              label: "2D viewport preferences",
              wide: true,
              render: () => (
                <div className="grid gap-2.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span>Colormap</span>
                    <div className="w-40">
                      <Select
                        value={displayState.colormap}
                        onValueChange={(colormap) =>
                          setDisplayState((prev) => ({ ...prev, colormap }))
                        }
                      >
                        <SelectTrigger
                          aria-label="2D slice colormap"
                          density="compact"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cmcrameri_vik">
                            Vik (diverging)
                          </SelectItem>
                          <SelectItem value="cmcrameri_batlow">
                            Batlow
                          </SelectItem>
                          <SelectItem value="hsl_spin">HSL in-plane</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>In-plane vector arrows</span>
                    <Switch
                      aria-label="Show 2D slice vector arrows"
                      checked={displayState.showArrows}
                      onCheckedChange={(showArrows) =>
                        setDisplayState((prev) => ({ ...prev, showArrows }))
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>Symmetric color scale</span>
                    <Switch
                      aria-label="Symmetric 2D color scale"
                      checked={displayState.symmetricRange}
                      onCheckedChange={(symmetricRange) =>
                        setDisplayState((prev) => ({ ...prev, symmetricRange }))
                      }
                    />
                  </div>
                </div>
              ),
            },
          ],
        },
      ],
      commitBar: {
        mode: "staged",
        onApply: async (d) => {
          setLocalBaseline(d);
          return true;
        },
      },
    }),
    [displayState, localBaseline.name, monitorId],
  );

  return (
    <ConnectedInspectorSpec
      baseline={localBaseline}
      selection={selection}
      spec={spec}
    />
  );
}
