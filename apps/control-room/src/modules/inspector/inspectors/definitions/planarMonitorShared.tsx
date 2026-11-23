"use client";

import {
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { VisualizationStatePatch } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import * as geometryLifecycleResources from "@/kernel/resources/geometryLifecycleResources";
import { resolveSessionDiscretization } from "@/kernel/resources/sessionDiscretization";
import { useSessionStatusSelector } from "@/kernel/resources/useSessionStatus";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import type { PlanarMonitor, PlanarMonitorDraft } from "@/kernel/workspace/crossSectionWorkspace";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";
import { PlanarVisualizationSection } from "../../visualization/PlanarVisualizationSection";
import { VisualizationContextSwitch } from "../../visualization/VisualizationContextSwitch";
import {
  resolvePlanarMonitorDefinitionAvailability,
  type PlanarMonitorDefinitionAvailability,
} from "../../panels/PlanarMonitorDefinitionEditor.model";

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

export function useSafePlanarMonitorDefinitionAvailability(): PlanarMonitorDefinitionAvailability {
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

export interface PlanarMonitorGeometryDraft {
  name: string;
  normalPreset: "xy" | "xz" | "yz" | "custom";
  planeOffsetM: number;
  normalVector: readonly [number, number, number];
  samplesU: number;
  samplesV: number;
}

export interface PlanarDisplayViewportState {
  colormap: string;
  showArrows: boolean;
  symmetricRange: boolean;
}

export interface PlanarMonitorTemplateDraft extends PlanarMonitorDraft {
  name: string;
}

export const EMPTY_SET: ReadonlySet<string> = new Set();

export const DEFAULT_PLANAR_GEOMETRY_DRAFT: PlanarMonitorGeometryDraft = {
  name: "xy_midplane",
  normalPreset: "xy",
  planeOffsetM: 0,
  normalVector: [0, 0, 1],
  samplesU: 128,
  samplesV: 128,
};

export const DEFAULT_PLANAR_DISPLAY: PlanarDisplayViewportState = {
  colormap: "cmcrameri_vik",
  showArrows: true,
  symmetricRange: true,
};

export function toTemplateDraft(draft: PlanarMonitorDraft): PlanarMonitorTemplateDraft {
  return {
    ...draft,
    name: draft.monitor.name,
  };
}

export function createDefaultCanonicalMonitor(name: string): PlanarMonitor {
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

export function formatMonitorOriginOffsetSummary(monitor: PlanarMonitor): string {
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

export function ConnectedPlanar2DDisplayBody({
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

export function CodePreviewDialog({
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
