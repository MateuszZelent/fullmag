"use client";

import {
  Compass,
  Palette,
  RotateCcw,
  Slice,
} from "lucide-react";
import {
  useContext,
  useMemo,
  useState,
} from "react";
import { KernelContext } from "@/kernel/KernelContext";
import { usePlanarMonitorResource } from "@/kernel/resources/planarMonitorResources";
import type { Selection } from "@/kernel/selection/selectionTypes";
import { Button } from "@/shared/ui/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec } from "../../template";
import { ConnectedInspectorSpec, LENGTH_UNITS_SI } from "../../panels/study/ConnectedInspectorSpec";
import {
  useSafePlanarMonitorDefinitionAvailability,
  type PlanarMonitorGeometryDraft,
  DEFAULT_PLANAR_GEOMETRY_DRAFT,
  type PlanarDisplayViewportState,
  DEFAULT_PLANAR_DISPLAY,
} from "./planarMonitorShared";
import { CommittedPlanarMonitorTemplateEditor } from "./PlanarMonitorCommittedEditor";

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
