"use client";

import { useRef, type ReactNode } from "react";
import {
  Box,
  Camera,
  Compass,
  Download,
  Eye,
  FlaskConical,
  Gauge,
  Layers,
  Maximize,
  Settings,
  Sparkles,
} from "lucide-react";

import { Button } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/Popover";
import { Separator } from "@/shared/ui/Separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/Tooltip";
import { useToolbarRovingFocus } from "@/shared/ui/useToolbarRovingFocus";
import {
  VIEWPORT_3D_QUALITY_PROFILE_DESCRIPTIONS,
  VIEWPORT_3D_QUALITY_PROFILE_LABELS,
  VIEWPORT_3D_QUALITY_PROFILE_OPTIONS,
  VIEWPORT_3D_QUALITY_PROFILE_SUMMARIES,
} from "@/shared/viewport3dQualityLabels";

import { useViewport3DCommandState } from "../viewport3dStore";
import { selectViewport3DRenderMode } from "./Viewport3DVisualizationModeControl";

import { VIEW_DIRECTION_COMMANDS } from "../viewport3dViewDirections";
import type { Viewport3DVisualProfileId } from "../viewport3dVisualProfile";

const ICON_SIZE = 16;

/* Scientific keeps exact field colors; Presentation adds studio light,
   soft shadows, ambient occlusion and tone mapping. */
const RENDER_MODES = [
  {
    description: "Scientific: exact field colors for quantitative reading. Lighting effects stay off while field data is shown.",
    icon: FlaskConical,
    label: "Scientific",
    value: "scientific",
  },
  {
    description: "Presentation: studio lighting, soft shadows, ambient occlusion and tone mapping. Shading changes field colors; use Scientific to read values.",
    icon: Sparkles,
    label: "Presentation",
    value: "presentation",
  },
] as const;

export interface Viewport3DToolbarProps {
  onCommand: (id: string) => void;
  projection: "perspective" | "orthographic";
  qualityProfileId: Viewport3DVisualProfileId;
  settingsOpen: boolean;
  inspectEnabled: boolean;
  layersContent: ReactNode;
  fitDisabledReason?: string | null;
}

/** Compact, presentation-only controls for the active 3D view. */
export function Viewport3DToolbar({
  onCommand,
  projection,
  qualityProfileId,
  settingsOpen,
  inspectEnabled,
  layersContent,
  fitDisabledReason,
}: Viewport3DToolbarProps) {
  const { appearance } = useViewport3DCommandState();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarKeyDown = useToolbarRovingFocus(toolbarRef);
  const fitReason = fitDisabledReason?.trim() || null;
  const qualityLabel = qualityProfileId === "capture"
    ? "Capture"
    : VIEWPORT_3D_QUALITY_PROFILE_LABELS[qualityProfileId];
  const projectionLabel = projection === "orthographic" ? "Orthographic" : "Perspective";

  return (
    <TooltipProvider delayDuration={300}>
      <div
        aria-label="3D view tools"
        className="fm-viewport-3d-toolbar"
        onKeyDown={toolbarKeyDown}
        ref={toolbarRef}
        role="toolbar"
      >
        <div aria-label="Navigation" className="fm-viewport-3d-toolbar__group" role="group">
          <ToolbarTooltip content={fitReason ?? "Fit the scene to the viewport"}>
            <Button
              aria-description={fitReason ?? undefined}
              aria-disabled={fitReason ? true : undefined}
              aria-label="Fit view"
              className="fm-viewport-3d-toolbar__button"
              data-command-id="viewport-3d.fit"
              onClick={() => {
                if (!fitReason) onCommand("viewport-3d.fit");
              }}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Maximize aria-hidden="true" size={ICON_SIZE} />
              <span className="fm-viewport-3d-toolbar__label">Fit</span>
            </Button>
          </ToolbarTooltip>

          <DropdownMenu modal={false}>
            <ToolbarTooltip content="Choose a standard view direction">
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Standard views"
                  className="fm-viewport-3d-toolbar__button"
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Compass aria-hidden="true" size={ICON_SIZE} />
                  <span className="fm-viewport-3d-toolbar__label">Views</span>
                </Button>
              </DropdownMenuTrigger>
            </ToolbarTooltip>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Standard views</DropdownMenuLabel>
              {VIEW_DIRECTION_COMMANDS.map((command) => (
                <DropdownMenuItem key={command.id} onSelect={() => onCommand(command.id)}>
                  {command.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Separator className="fm-viewport-3d-toolbar__separator" orientation="vertical" />

        <div aria-label="Projection" className="fm-viewport-3d-toolbar__group" role="group">
          <ToolbarTooltip
            content={`Switch to ${projection === "orthographic" ? "perspective" : "orthographic"} projection`}
          >
            <Button
              aria-label="Projection"
              aria-pressed={projection === "orthographic"}
              className="fm-viewport-3d-toolbar__button"
              data-command-id="view-projection"
              data-projection={projection}
              onClick={() => onCommand("view-projection")}
              size="icon"
              type="button"
              variant={projection === "orthographic" ? "primary" : "ghost"}
            >
              <Box aria-hidden="true" size={ICON_SIZE} />
              <span className="fm-viewport-3d-toolbar__label">Projection</span>
              <span aria-hidden="true" className="fm-viewport-3d-toolbar__current">
                {projectionLabel}
              </span>
            </Button>
          </ToolbarTooltip>
        </div>

        <Separator className="fm-viewport-3d-toolbar__separator" orientation="vertical" />

        <div aria-label="Inspection" className="fm-viewport-3d-toolbar__group" role="group">
          <ToolbarTooltip content="Inspect field values in the view">
            <Button
              aria-label="Inspect values"
              aria-pressed={inspectEnabled}
              className="fm-viewport-3d-toolbar__button"
              data-command-id="viewport-3d.inspect-toggle"
              onClick={() => onCommand("viewport-3d.inspect-toggle")}
              size="icon"
              type="button"
              variant={inspectEnabled ? "primary" : "ghost"}
            >
              <Eye aria-hidden="true" size={ICON_SIZE} />
              <span className="fm-viewport-3d-toolbar__label">Inspect</span>
            </Button>
          </ToolbarTooltip>
        </div>

        <Separator className="fm-viewport-3d-toolbar__separator" orientation="vertical" />

        <div aria-label="Layers" className="fm-viewport-3d-toolbar__group" role="group">
          <Popover modal={false}>
            <ToolbarTooltip content="Show or hide view layers">
              <PopoverTrigger asChild>
                <Button
                  aria-label="Layers"
                  className="fm-viewport-3d-toolbar__button"
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Layers aria-hidden="true" size={ICON_SIZE} />
                  <span className="fm-viewport-3d-toolbar__label">Layers</span>
                </Button>
              </PopoverTrigger>
            </ToolbarTooltip>
            <PopoverContent
              align="start"
              aria-label="View layers"
              className="fm-viewport-3d-toolbar__layers-content"
              side="bottom"
            >
              {layersContent}
            </PopoverContent>
          </Popover>
        </div>

        <Separator className="fm-viewport-3d-toolbar__separator" orientation="vertical" />

        <div aria-label="Visualization mode" className="fm-viewport-3d-toolbar__group fm-viewport-3d-toolbar__mode" role="radiogroup">
          {RENDER_MODES.map(({ description, icon: Icon, label, value }) => (
            <ToolbarTooltip content={description} key={value}>
              <Button
                aria-checked={appearance.renderMode === value}
                aria-label={label}
                className="fm-viewport-3d-toolbar__button fm-viewport-3d-toolbar__mode-item"
                data-render-mode={value}
                role="radio"
                size="icon"
                type="button"
                variant="ghost"
                onClick={() => selectViewport3DRenderMode(appearance.renderMode, value)}
              >
                <Icon aria-hidden="true" size={ICON_SIZE} />
                <span className="fm-viewport-3d-toolbar__label">{label}</span>
              </Button>
            </ToolbarTooltip>
          ))}
        </div>

        <Separator className="fm-viewport-3d-toolbar__separator" orientation="vertical" />

        <div aria-label="Quality" className="fm-viewport-3d-toolbar__group" role="group">
          <DropdownMenu modal={false}>
            <ToolbarTooltip content={`Quality profile: ${qualityLabel}`}>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Quality profile: ${qualityLabel}`}
                  className="fm-viewport-3d-toolbar__button"
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Gauge aria-hidden="true" size={ICON_SIZE} />
                  <span className="fm-viewport-3d-toolbar__label">Quality</span>
                  <span aria-hidden="true" className="fm-viewport-3d-toolbar__current">
                    {qualityLabel}
                  </span>
                </Button>
              </DropdownMenuTrigger>
            </ToolbarTooltip>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Quality profile</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                onValueChange={(value) => {
                  if (VIEWPORT_3D_QUALITY_PROFILE_OPTIONS.some(([id]) => id === value)) {
                    onCommand(`viewport-3d.profile-${value}`);
                  }
                }}
                value={qualityProfileId === "capture" ? "" : qualityProfileId}
              >
                {VIEWPORT_3D_QUALITY_PROFILE_OPTIONS.map(([id, label]) => (
                  <DropdownMenuRadioItem
                    className="fm-viewport-3d-toolbar__quality-item"
                    key={id}
                    title={VIEWPORT_3D_QUALITY_PROFILE_DESCRIPTIONS[id]}
                    value={id}
                  >
                    <span className="fm-viewport-3d-toolbar__quality-name">{label}</span>
                    <span className="fm-viewport-3d-toolbar__quality-summary">
                      {VIEWPORT_3D_QUALITY_PROFILE_SUMMARIES[id]}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Separator className="fm-viewport-3d-toolbar__separator" orientation="vertical" />

        <div aria-label="Export" className="fm-viewport-3d-toolbar__group" role="group">
          <ToolbarTooltip content="Capture the current 3D view as a PNG">
            <Button
              aria-label="Export PNG"
              className="fm-viewport-3d-toolbar__button"
              data-command-id="viewport-3d.capture-frame"
              onClick={() => onCommand("viewport-3d.capture-frame")}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Camera aria-hidden="true" size={ICON_SIZE} />
              <span className="fm-viewport-3d-toolbar__label">PNG</span>
            </Button>
          </ToolbarTooltip>
          <ToolbarTooltip content="Export the current view as a 3D model">
            <Button
              aria-label="Export 3D model"
              className="fm-viewport-3d-toolbar__button"
              data-command-id="viewport-3d.export-model"
              onClick={() => onCommand("viewport-3d.export-model")}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Download aria-hidden="true" size={ICON_SIZE} />
              <span className="fm-viewport-3d-toolbar__label">3D model</span>
            </Button>
          </ToolbarTooltip>
        </div>

        <Separator className="fm-viewport-3d-toolbar__separator" orientation="vertical" />

        <div aria-label="Settings" className="fm-viewport-3d-toolbar__group" role="group">
          <ToolbarTooltip content="Open view settings">
            <Button
              aria-label="View settings"
              aria-pressed={settingsOpen}
              className="fm-viewport-3d-toolbar__button"
              data-command-id="viewport-3d.toggle-settings"
              onClick={() => onCommand("viewport-3d.toggle-settings")}
              size="icon"
              type="button"
              variant={settingsOpen ? "primary" : "ghost"}
            >
              <Settings aria-hidden="true" size={ICON_SIZE} />
              <span className="fm-viewport-3d-toolbar__label">Settings</span>
            </Button>
          </ToolbarTooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}

function ToolbarTooltip({ children, content }: { children: ReactNode; content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
}
