"use client";

import { useCallback, useMemo } from "react";
import { useModel } from "../../runs/control-room/context-hooks";
import {
  useVisualizationStore,
  selectVisualizationProjectPresets,
  selectVisualizationLocalPresets,
  selectActiveVisualizationPresetRef,
} from "@/features/visualization";
import {
  buildVisualizationPresetNodeId,
  parseVisualizationPresetNodeId,
  VISUALIZATION_LOCAL_SECTION_NODE_ID,
  VISUALIZATION_PROJECT_SECTION_NODE_ID,
  VISUALIZATION_ROOT_NODE_ID,
} from "../../runs/control-room/visualizationPresets";
import type {
  VisualizationArrowColorMode,
  VisualizationPresetRef,
  VisualizationPresetSource,
} from "@/lib/session/types";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SidebarSection } from "./primitives";

interface VisualizationPresetPanelProps {
  nodeId: string;
}

const FEM_RENDER_OPTIONS = ["surface", "surface+edges", "wireframe", "points"] as const;
const ARROW_COLOR_OPTIONS: VisualizationArrowColorMode[] = [
  "orientation",
  "x",
  "y",
  "z",
  "magnitude",
  "monochrome",
];

function samePresetRef(left: VisualizationPresetRef | null, right: VisualizationPresetRef): boolean {
  if (!left) return false;
  return left.source === right.source && left.preset_id === right.preset_id;
}

function PresetSourceBadge({ source }: { source: VisualizationPresetSource }) {
  return (
    <span className="rounded border border-border/10 bg-card/40 px-2 py-0.5 text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
      {source}
    </span>
  );
}

export default function VisualizationPresetPanel({ nodeId }: VisualizationPresetPanelProps) {
  const ctx = useModel();
  const visualizationProjectPresets = useVisualizationStore(selectVisualizationProjectPresets);
  const visualizationLocalPresets = useVisualizationStore(selectVisualizationLocalPresets);
  const activeVisualizationPresetRef = useVisualizationStore(selectActiveVisualizationPresetRef);
  const parsedNode = useMemo(() => parseVisualizationPresetNodeId(nodeId), [nodeId]);

  const createPreset = useCallback(
    (source: VisualizationPresetSource) => {
      const ref = ctx.createVisualizationPreset(source);
      ctx.setActiveVisualizationPresetRef(ref);
      ctx.applyVisualizationPreset(ref);
      ctx.setSelectedSidebarNodeId(buildVisualizationPresetNodeId(source, ref.preset_id));
    },
    [ctx],
  );

  const isRootNode = nodeId === VISUALIZATION_ROOT_NODE_ID;
  const isProjectSectionNode = nodeId === VISUALIZATION_PROJECT_SECTION_NODE_ID;
  const isLocalSectionNode = nodeId === VISUALIZATION_LOCAL_SECTION_NODE_ID;
  const sectionSource: VisualizationPresetSource | null = isProjectSectionNode
    ? "project"
    : isLocalSectionNode
      ? "local"
      : null;
  const presetsForNode =
    parsedNode?.source === "project"
      ? visualizationProjectPresets
      : parsedNode?.source === "local"
        ? visualizationLocalPresets
        : [];
  const preset =
    parsedNode ? presetsForNode.find((entry) => entry.id === parsedNode.presetId) ?? null : null;
  const presetRef: VisualizationPresetRef | null =
    parsedNode && preset
      ? {
          source: parsedNode.source,
          preset_id: preset.id,
        }
      : null;

  if (isRootNode) {
    return (
      <SidebarSection title="Visualization Presets" icon="🎛️" defaultOpen={true}>
        <div className="space-y-2 text-[0.72rem] text-muted-foreground">
          <p>Tree-first presets: create, apply, and persist viewport configurations for FEM/FDM/2D.</p>
          <div className="grid grid-cols-1 gap-2 @[260px]:grid-cols-2">
            <Button size="sm" variant="default" onClick={() => createPreset("project")}>
              New Project Preset
            </Button>
            <Button size="sm" variant="outline" onClick={() => createPreset("local")}>
              New Local Preset
            </Button>
          </div>
          <div className="rounded border border-border/10 bg-card/40 p-2 text-[0.68rem] leading-relaxed">
            <div>Project presets: {visualizationProjectPresets.length}</div>
            <div>Local presets: {visualizationLocalPresets.length}</div>
          </div>
        </div>
      </SidebarSection>
    );
  }

  if (sectionSource) {
    const count =
      sectionSource === "project"
        ? visualizationProjectPresets.length
        : visualizationLocalPresets.length;
    return (
      <SidebarSection title={`${sectionSource === "project" ? "Project" : "Local"} Presets`} icon="📚" defaultOpen={true}>
        <div className="space-y-2 text-[0.72rem] text-muted-foreground">
          <p>Manage presets stored in the {sectionSource} scope.</p>
          <div className="rounded border border-border/10 bg-card/40 p-2 text-[0.68rem]">
            {count} preset{count === 1 ? "" : "s"} in this section.
          </div>
          <Button size="sm" variant="default" onClick={() => createPreset(sectionSource)}>
            Create Preset
          </Button>
        </div>
      </SidebarSection>
    );
  }

  if (!parsedNode) {
    return null;
  }

  if (!preset) {
    return (
      <SidebarSection title="Visualization Preset" icon="⚠️" defaultOpen={true}>
        <div className="rounded border border-warning/30 bg-warning/10 p-3 text-[0.72rem] text-warning">
          Preset not found. It may have been removed in another view.
        </div>
      </SidebarSection>
    );
  }

  if (!presetRef) {
    return null;
  }
  const isActive = samePresetRef(activeVisualizationPresetRef, presetRef);

  const renameIfNeeded = (nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === preset.name) {
      return;
    }
    ctx.renameVisualizationPreset(presetRef, trimmed);
  };

  const updateFem = (patch: Partial<typeof preset.fem>) => {
    ctx.updateVisualizationPreset(presetRef, (current) => ({
      ...current,
      fem: {
        ...current.fem,
        ...patch,
      },
    }));
  };

  const updateFdm = (patch: Partial<typeof preset.fdm>) => {
    ctx.updateVisualizationPreset(presetRef, (current) => ({
      ...current,
      fdm: {
        ...current.fdm,
        ...patch,
      },
    }));
  };

  const updateTwoD = (patch: Partial<typeof preset.two_d>) => {
    ctx.updateVisualizationPreset(presetRef, (current) => ({
      ...current,
      two_d: {
        ...current.two_d,
        ...patch,
      },
    }));
  };

  return (
    <div className="flex flex-col gap-2">
      <SidebarSection title="Preset" icon="🎛️" badge={isActive ? "active" : undefined} defaultOpen={true}>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <PresetSourceBadge source={parsedNode.source} />
            <span className="text-[0.62rem] text-muted-foreground">{preset.domain.toUpperCase()} / {preset.mode}</span>
          </div>
          <div className="space-y-1">
            <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">Name</label>
            <Input
              key={`${preset.id}:${preset.name}`}
              defaultValue={preset.name}
              onBlur={(event) => renameIfNeeded(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  renameIfNeeded((event.currentTarget as HTMLInputElement).value);
                  (event.currentTarget as HTMLInputElement).blur();
                }
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant={isActive ? "secondary" : "default"}
              onClick={() => {
                ctx.setActiveVisualizationPresetRef(presetRef);
                ctx.applyVisualizationPreset(presetRef);
              }}
            >
              {isActive ? "Re-Apply" : "Apply"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const next = ctx.duplicateVisualizationPreset(presetRef, parsedNode.source);
                if (!next) return;
                ctx.setSelectedSidebarNodeId(
                  buildVisualizationPresetNodeId(next.source, next.preset_id),
                );
              }}
            >
              Duplicate
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const target = parsedNode.source === "project" ? "local" : "project";
                const moved = ctx.copyVisualizationPresetToSource(presetRef, target);
                if (!moved) return;
                ctx.setSelectedSidebarNodeId(
                  buildVisualizationPresetNodeId(moved.source, moved.preset_id),
                );
              }}
            >
              Save To {parsedNode.source === "project" ? "Local" : "Project"}
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                if (!window.confirm(`Delete preset "${preset.name}"?`)) {
                  return;
                }
                ctx.deleteVisualizationPreset(presetRef);
                ctx.setSelectedSidebarNodeId(
                  parsedNode.source === "project"
                    ? VISUALIZATION_PROJECT_SECTION_NODE_ID
                    : VISUALIZATION_LOCAL_SECTION_NODE_ID,
                );
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      </SidebarSection>

      <SidebarSection title="FEM 3D" icon="🧲" defaultOpen={preset.domain === "fem"}>
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
              Render
              <select
                className="mt-1 w-full rounded border border-border/10 bg-background px-2 py-1 text-xs"
                value={preset.fem.render_mode}
                onChange={(event) => updateFem({ render_mode: event.target.value as (typeof FEM_RENDER_OPTIONS)[number] })}
              >
                {FEM_RENDER_OPTIONS.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
              View
              <select
                className="mt-1 w-full rounded border border-border/10 bg-background px-2 py-1 text-xs"
                value={preset.fem.object_view_mode}
                onChange={(event) => updateFem({ object_view_mode: event.target.value as "context" | "isolate" })}
              >
                <option value="context">context</option>
                <option value="isolate">isolate</option>
              </select>
            </label>
            <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
              Vector Domain
              <select
                className="mt-1 w-full rounded border border-border/10 bg-background px-2 py-1 text-xs"
                value={preset.fem.vector_domain_filter}
                onChange={(event) =>
                  updateFem({
                    vector_domain_filter: event.target.value as
                      | "auto"
                      | "magnetic_only"
                      | "full_domain"
                      | "airbox_only",
                  })
                }
              >
                <option value="auto">auto</option>
                <option value="magnetic_only">magnetic_only</option>
                <option value="full_domain">full_domain</option>
                <option value="airbox_only">airbox_only</option>
              </select>
            </label>
            <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
              Ferro in Airbox
              <select
                className="mt-1 w-full rounded border border-border/10 bg-background px-2 py-1 text-xs"
                value={preset.fem.ferromagnet_visibility_mode}
                onChange={(event) =>
                  updateFem({
                    ferromagnet_visibility_mode: event.target.value as "hide" | "ghost",
                  })
                }
              >
                <option value="hide">hide</option>
                <option value="ghost">ghost</option>
              </select>
            </label>
          </div>

          <label className="flex items-center justify-between gap-2 text-[0.68rem] text-muted-foreground">
            Show Arrows
            <input
              type="checkbox"
              checked={preset.fem.show_arrows}
              onChange={(event) => updateFem({ show_arrows: event.target.checked })}
            />
          </label>

          <label className="block text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Points: {preset.fem.max_points}
            <input
              type="range"
              className="mt-1 w-full accent-primary"
              min={512}
              max={131072}
              step={512}
              value={preset.fem.max_points}
              onChange={(event) => updateFem({ max_points: Number(event.target.value) })}
            />
          </label>

          <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Arrow Coloring
            <select
              className="mt-1 w-full rounded border border-border/10 bg-background px-2 py-1 text-xs"
              value={preset.fem.arrow_color_mode}
              onChange={(event) =>
                updateFem({
                  arrow_color_mode: event.target.value as VisualizationArrowColorMode,
                })
              }
            >
              {ARROW_COLOR_OPTIONS.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>

          {preset.fem.arrow_color_mode === "monochrome" ? (
            <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
              Arrow Color
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="color"
                  value={preset.fem.arrow_mono_color}
                  onChange={(event) => updateFem({ arrow_mono_color: event.target.value })}
                  className="h-7 w-10 cursor-pointer rounded border border-border/10 bg-transparent p-0"
                />
                <span className="font-mono text-[0.68rem]">{preset.fem.arrow_mono_color}</span>
              </div>
            </label>
          ) : null}

          <label className="block text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Arrow Alpha: {preset.fem.arrow_alpha.toFixed(2)}
            <input
              type="range"
              className="mt-1 w-full accent-primary"
              min={0.05}
              max={1}
              step={0.05}
              value={preset.fem.arrow_alpha}
              onChange={(event) => updateFem({ arrow_alpha: Number(event.target.value) })}
            />
          </label>

          <label className="block text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Arrow Length: {preset.fem.arrow_length_scale.toFixed(2)}
            <input
              type="range"
              className="mt-1 w-full accent-primary"
              min={0.35}
              max={2.8}
              step={0.05}
              value={preset.fem.arrow_length_scale}
              onChange={(event) => updateFem({ arrow_length_scale: Number(event.target.value) })}
            />
          </label>

          <label className="block text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Arrow Width: {preset.fem.arrow_thickness.toFixed(2)}
            <input
              type="range"
              className="mt-1 w-full accent-primary"
              min={0.35}
              max={2.8}
              step={0.05}
              value={preset.fem.arrow_thickness}
              onChange={(event) => updateFem({ arrow_thickness: Number(event.target.value) })}
            />
          </label>
        </div>
      </SidebarSection>

      <SidebarSection title="FDM 3D" icon="🧱" defaultOpen={preset.domain === "fdm"}>
        <div className="space-y-2">
          <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Render
            <select
              className="mt-1 w-full rounded border border-border/10 bg-background px-2 py-1 text-xs"
              value={preset.fdm.render_mode}
              onChange={(event) => updateFdm({ render_mode: event.target.value as "glyph" | "voxel" })}
            >
              <option value="glyph">glyph</option>
              <option value="voxel">voxel</option>
            </select>
          </label>
          <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Quality
            <select
              className="mt-1 w-full rounded border border-border/10 bg-background px-2 py-1 text-xs"
              value={preset.fdm.quality}
              onChange={(event) => updateFdm({ quality: event.target.value as "low" | "high" | "ultra" })}
            >
              <option value="low">low</option>
              <option value="high">high</option>
              <option value="ultra">ultra</option>
            </select>
          </label>
          <label className="block text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Brightness: {preset.fdm.brightness.toFixed(2)}
            <input
              type="range"
              className="mt-1 w-full accent-primary"
              min={0.3}
              max={3}
              step={0.1}
              value={preset.fdm.brightness}
              onChange={(event) => updateFdm({ brightness: Number(event.target.value) })}
            />
          </label>
        </div>
      </SidebarSection>

      <SidebarSection title="2D" icon="📐" defaultOpen={preset.mode === "2D"}>
        <div className="space-y-2">
          <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Component
            <select
              className="mt-1 w-full rounded border border-border/10 bg-background px-2 py-1 text-xs"
              value={preset.two_d.component}
              onChange={(event) =>
                updateTwoD({ component: event.target.value as "x" | "y" | "z" | "magnitude" })
              }
            >
              <option value="x">x</option>
              <option value="y">y</option>
              <option value="z">z</option>
              <option value="magnitude">magnitude</option>
            </select>
          </label>
          <label className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">
            Plane
            <select
              className="mt-1 w-full rounded border border-border/10 bg-background px-2 py-1 text-xs"
              value={preset.two_d.plane}
              onChange={(event) =>
                updateTwoD({ plane: event.target.value as "xy" | "xz" | "yz" })
              }
            >
              <option value="xy">xy</option>
              <option value="xz">xz</option>
              <option value="yz">yz</option>
            </select>
          </label>
          <div className="rounded border border-border/10 bg-card/40 p-2 text-[0.68rem] text-muted-foreground">
            Unsupported in current viewport mode controls are preserved and applied when mode/data are available.
          </div>
        </div>
      </SidebarSection>
    </div>
  );
}
