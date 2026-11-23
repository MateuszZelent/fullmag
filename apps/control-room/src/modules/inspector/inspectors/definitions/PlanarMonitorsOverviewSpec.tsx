"use client";

import {
  Compass,
  Eye,
  Layers,
  Plus,
  Slice,
} from "lucide-react";
import {
  useCallback,
  useContext,
  useMemo,
} from "react";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { KernelContext } from "@/kernel/KernelContext";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import {
  discardPlanarMonitorDraft,
  type PlanarMonitor,
  type PlanarMonitorDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import { Button } from "@/shared/ui/Button";
import { EmptyState } from "@/shared/ui/EmptyState";
import type { InspectorPanelProps } from "../../inspectorTypes";
import type { InspectorSpec } from "../../template";
import { ConnectedInspectorSpec } from "../../panels/study/ConnectedInspectorSpec";
import {
  type PlanarMonitorGeometryDraft,
  DEFAULT_PLANAR_GEOMETRY_DRAFT,
} from "./planarMonitorShared";

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
