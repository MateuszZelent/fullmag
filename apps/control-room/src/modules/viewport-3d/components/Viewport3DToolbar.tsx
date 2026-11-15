"use client";

import { useRef, type ReactNode } from "react";
import {
  Box,
  Camera,
  Compass,
  Eye,
  Gauge,
  Layers,
  Maximize,
  Settings,
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

import { VIEW_DIRECTION_COMMANDS } from "../viewport3dViewDirections";
import type { Viewport3DVisualProfileId } from "../viewport3dVisualProfile";

const ICON_SIZE = 16;

const QUALITY_PROFILE_OPTIONS: ReadonlyArray<{
  id: Exclude<Viewport3DVisualProfileId, "capture">;
  label: string;
}> = [
  { id: "interactive-lite", label: "Interactive Lite" },
  { id: "interactive", label: "Interactive" },
  { id: "balanced", label: "Balanced" },
  { id: "figure", label: "Figure" },
];

const QUALITY_PROFILE_LABELS: Record<Viewport3DVisualProfileId, string> = {
  "interactive-lite": "Interactive Lite",
  interactive: "Interactive",
  balanced: "Balanced",
  figure: "Figure",
  capture: "Capture",
};

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
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarKeyDown = useToolbarRovingFocus(toolbarRef);
  const fitReason = fitDisabledReason?.trim() || null;
  const qualityLabel = QUALITY_PROFILE_LABELS[qualityProfileId];
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

        <div aria-label="Quality" className="fm-viewport-3d-toolbar__group" role="group">
          <DropdownMenu modal={false}>
            <ToolbarTooltip content={`Render quality: ${qualityLabel}`}>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Quality: ${qualityLabel}`}
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
              <DropdownMenuLabel>Render quality</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                onValueChange={(value) => {
                  if (QUALITY_PROFILE_OPTIONS.some((option) => option.id === value)) {
                    onCommand(`viewport-3d.profile-${value}`);
                  }
                }}
                value={qualityProfileId === "capture" ? "" : qualityProfileId}
              >
                {QUALITY_PROFILE_OPTIONS.map((profile) => (
                  <DropdownMenuRadioItem key={profile.id} value={profile.id}>
                    {profile.label}
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
