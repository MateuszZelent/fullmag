"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Download, Plus } from "lucide-react";

import type { CrossSectionImageQuery } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import { useCrossSectionImageResource } from "@/kernel/resources/crossSectionResources";
import type { KernelApi } from "@/kernel/types";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import {
  activeCrossSectionPlot,
  beginCrossSectionDraft,
  beginCrossSectionDraftFromPlot,
  type CrossSectionDraft,
  type CrossSectionPlot,
  selectCrossSectionPlot,
} from "@/kernel/workspace/crossSectionWorkspace";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import { Button } from "@/shared/ui/Button";

import { createObjectUrlEffect } from "./objectUrl";

const FALLBACK_QUERY: CrossSectionImageQuery = {
  metric: "skewness",
  plane: "xy",
  positionPercent: 50,
};
const CROSS_SECTION_IMAGE_PREVIEW_RESOLUTION = 1024;
const CROSS_SECTION_IMAGE_RESOLUTION_PRESETS = [1024, 2048, 4096] as const;
type CrossSectionImageResolution =
  (typeof CROSS_SECTION_IMAGE_RESOLUTION_PRESETS)[number];

export default function CrossSectionImageModule() {
  const kernel = useKernel();
  const visualizationState = useVisualizationStateResource();
  const workspace = useCrossSectionWorkspaceSelector((state) => state);
  const plot = activeCrossSectionPlot(workspace);
  const [resolution, setResolution] = useState<CrossSectionImageResolution>(
    CROSS_SECTION_IMAGE_PREVIEW_RESOLUTION,
  );
  const imageQuery = useMemo(
    () => (plot ? crossSectionImageQueryFromPlot(plot, resolution) : FALLBACK_QUERY),
    [plot, resolution],
  );
  const image = useCrossSectionImageResource(imageQuery, {
    enabled: Boolean(plot),
  });
  const imageUrl = useObjectUrl(image.data, "image/png");
  const startNewDraft = () => {
    const draft = plot
      ? beginCrossSectionDraftFromPlot(plot.id)
      : beginCrossSectionDraft(visualizationState.data);
    if (!draft) return;
    selectDraftInWorkspace(kernel, draft);
  };
  const selectPlotInWorkspace = (entry: CrossSectionPlot) => {
    const selected = selectCrossSectionPlot(entry.id);
    if (!selected) return;
    selectPlot(kernel, selected);
  };

  if (!plot) {
    return (
      <div className="fm-cross-section-image fm-cross-section-image--empty">
        <div className="fm-cross-section-image__empty">
          <Button size="sm" type="button" variant="primary" onClick={startNewDraft}>
            <Plus size={14} aria-hidden="true" />
            New Image
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fm-cross-section-image">
      <div className="fm-cross-section-image__toolbar">
        <div className="fm-cross-section-image__plot-tabs" role="tablist">
          {workspace.plots.map((entry) => (
            <button
              key={entry.id}
              aria-selected={entry.id === plot.id}
              className="fm-cross-section-image__plot-tab"
              role="tab"
              type="button"
              onClick={() => selectPlotInWorkspace(entry)}
            >
              <span>{entry.name}</span>
              <small>
                {entry.plane.toUpperCase()} {entry.positionPercent}%
              </small>
            </button>
          ))}
        </div>
        <div className="fm-cross-section-image__actions">
          <div
            aria-label="Image resolution"
            className="fm-cross-section-image__resolution"
            role="group"
          >
            {CROSS_SECTION_IMAGE_RESOLUTION_PRESETS.map((preset) => (
              <button
                key={preset}
                aria-pressed={resolution === preset}
                className="fm-cross-section-image__resolution-button"
                type="button"
                onClick={() => setResolution(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
          <Button size="sm" type="button" variant="primary" onClick={startNewDraft}>
            <Plus size={14} aria-hidden="true" />
            New Image
          </Button>
          {imageUrl ? (
            <Button asChild size="sm" variant="secondary">
              <a
                download={`${plot.name.replace(/\s+/g, "-").toLowerCase()}-${resolution}px.png`}
                href={imageUrl}
              >
                <Download size={14} aria-hidden="true" />
                Download PNG
              </a>
            </Button>
          ) : null}
        </div>
      </div>
      <div className="fm-cross-section-image__stage">
        {image.status === "error" ? (
          <div className="fm-cross-section-image__empty">
            {image.error?.message ?? "Cross-section image unavailable"}
          </div>
        ) : null}
        {image.status !== "error" && !imageUrl ? (
          <div className="fm-cross-section-image__empty">
            {image.status === "ready"
              ? "No cross-section image available"
              : "Generating cross-section image"}
          </div>
        ) : null}
        {imageUrl ? (
          <Image
            alt={`${plot.name} cross-section`}
            className="fm-cross-section-image__img"
            height={imageQuery.resolution ?? CROSS_SECTION_IMAGE_PREVIEW_RESOLUTION}
            src={imageUrl}
            style={{ width: "100%", height: "auto" }}
            unoptimized
            width={imageQuery.resolution ?? CROSS_SECTION_IMAGE_PREVIEW_RESOLUTION}
          />
        ) : null}
      </div>
    </div>
  );
}

function crossSectionImageQueryFromPlot(
  plot: NonNullable<ReturnType<typeof activeCrossSectionPlot>>,
  resolution: CrossSectionImageResolution,
): CrossSectionImageQuery {
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio ?? 1, 2) : 1;
  return {
    colorScale: plot.renderOptions.colorScale,
    dpr,
    edgeWidth: plot.renderOptions.edgeWidth ?? 1.5,
    filterExpression: plot.renderOptions.filterExpression,
    legend: true,
    metric: plot.metric,
    plane: plot.plane,
    positionPercent: plot.positionPercent,
    resolution,
    rotationDegrees: plot.rotationDegrees,
    shrinkFactor: plot.renderOptions.shrinkFactor,
    wireframe: plot.renderOptions.wireframeVisible,
  };
}

function selectDraftInWorkspace(kernel: KernelApi, draft: CrossSectionDraft) {
  const nodeId = "model:visualizations-2d:draft";
  kernel.selection.set(
    {
      kind: "mesh.cross-section.draft",
      label: draft.name,
      nodeId,
      objectId: null,
      ref: {
        draftId: "draft",
        kind: "mesh.cross-section.draft",
        nodeId,
        type: "cross-section-draft",
        visualizationTargetId: "cross-section:draft",
      },
    },
    "cross-section-image",
  );
  kernel.layout.setPanelVisible("left", true);
  kernel.layout.setPanelVisible("right", true);
  kernel.layout.setFocusedSlot("viewport-main");
}

function selectPlot(kernel: KernelApi, plot: CrossSectionPlot) {
  const nodeId = `model:visualizations-2d:${plot.id}`;
  kernel.selection.set(
    {
      kind: "mesh.cross-section.plot",
      label: plot.name,
      nodeId,
      objectId: null,
      ref: {
        kind: "mesh.cross-section.plot",
        nodeId,
        plotId: plot.id,
        type: "cross-section-plot",
        visualizationTargetId: `cross-section:plot:${plot.id}`,
      },
    },
    "cross-section-image",
  );
  kernel.layout.setPanelVisible("right", true);
}

function useObjectUrl(data: ArrayBuffer | null, contentType: string): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    return createObjectUrlEffect(data, contentType, setUrl);
  }, [contentType, data]);

  return url;
}
