"use client";

import { useRef, useSyncExternalStore, type ReactNode } from "react";
import {
  Box,
  Camera,
  ChevronDown,
  Download,
  Ellipsis,
  Eye,
  FlaskConical,
  Layers,
  Maximize,
  Move,
  Orbit,
  Plane,
  RotateCw,
  Scaling,
  Settings,
  Sparkles,
} from "lucide-react";

import {
  getTextureDraftBridgeSnapshot,
  resolveActiveTextureGizmoMode,
  setTextureGizmoMode,
  subscribeTextureDraftBridge,
} from "@/shared/domain/magnetization-texture/textureDraftBridge";
import { Button } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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

import { selectViewport3DRenderMode, useViewport3DCommandState, viewport3dStore } from "../viewport3dStore";

import { VIEW_DIRECTION_COMMANDS } from "../viewport3dViewDirections";
import type { Viewport3DVisualProfileId } from "../viewport3dVisualProfile";

const ICON_SIZE = 16;

const INTERACTION_MODES = [
  {
    icon: Orbit,
    label: "Camera orbit (Q)",
    mode: "view",
    testId: "viewport-mode-camera",
  },
  {
    icon: Move,
    label: "Translate texture (W)",
    mode: "translate",
    testId: "viewport-mode-translate",
  },
  {
    icon: RotateCw,
    label: "Rotate texture (E)",
    mode: "rotate",
    testId: "viewport-mode-rotate",
  },
  {
    icon: Scaling,
    label: "Scale texture (R)",
    mode: "scale",
    testId: "viewport-mode-scale",
  },
] as const;

/* Orbit turns the scene around its target; a free camera flies with the
   wheel (through objects too) and looks around from where it stands. */
const CAMERA_MODES = [
  {
    description: "Drag turns the view around the model; the wheel zooms towards it.",
    icon: Orbit,
    label: "Orbit",
    value: "object",
  },
  {
    description: "The wheel flies forward and back, also through objects; drag looks around.",
    icon: Plane,
    label: "Free camera",
    value: "camera",
  },
] as const;

/* Scientific keeps exact field colors; Presentation adds studio light,
   soft shadows, ambient occlusion and tone mapping. */
const RENDER_MODES = [
  {
    description: "Exact field colors for reading values.",
    icon: FlaskConical,
    label: "Scientific",
    value: "scientific",
  },
  {
    description: "Studio light, soft shadows and tone mapping; shading changes field colors.",
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

/**
 * Controls for the active 3D view, in five groups: tools (orbit and the
 * texture gizmo, one segmented switch, Q/W/E/R), navigation (fit, camera
 * menu, projection), inspection (values, layers),
 * appearance (render mode and quality in one menu) and output (export,
 * settings). Container queries on the viewport drop labels first and then
 * fold the output group into the trailing "More" menu, so the pill stays
 * one row at any viewport width.
 */
export function Viewport3DToolbar({
  onCommand,
  projection,
  qualityProfileId,
  settingsOpen,
  inspectEnabled,
  layersContent,
  fitDisabledReason,
}: Viewport3DToolbarProps) {
  const { appearance, widgets } = useViewport3DCommandState();
  const textureBridge = useSyncExternalStore(
    subscribeTextureDraftBridge,
    getTextureDraftBridgeSnapshot,
    getTextureDraftBridgeSnapshot,
  );
  const activeInteractionMode = resolveActiveTextureGizmoMode(textureBridge);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarKeyDown = useToolbarRovingFocus(toolbarRef);
  const fitReason = fitDisabledReason?.trim() || null;
  const qualityLabel = qualityProfileId === "capture"
    ? "Capture"
    : VIEWPORT_3D_QUALITY_PROFILE_LABELS[qualityProfileId];
  const projectionLabel = projection === "orthographic" ? "Orthographic" : "Perspective";
  const cameraMode = CAMERA_MODES.find(({ value }) => value === widgets.rotationMode) ?? CAMERA_MODES[0];
  const renderMode = RENDER_MODES.find(({ value }) => value === appearance.renderMode) ?? RENDER_MODES[0];
  const CameraModeIcon = cameraMode.icon;
  const RenderModeIcon = renderMode.icon;
  const appearanceLabel = `Appearance: ${renderMode.label}, quality ${qualityLabel}`;

  return (
    <TooltipProvider delayDuration={300}>
      <div
        aria-label="3D view tools"
        className="fm-viewport-3d-toolbar"
        onKeyDown={toolbarKeyDown}
        ref={toolbarRef}
        role="toolbar"
      >
        <div aria-label="Interaction mode" className="fm-viewport-3d-toolbar__group fm-viewport-3d-toolbar__segment" role="group">
          {INTERACTION_MODES.map(({ icon: Icon, label, mode, testId }) => {
            const isActive = activeInteractionMode === mode;
            return (
              <ToolbarTooltip content={label} key={mode}>
                <Button
                  aria-label={label}
                  aria-pressed={isActive}
                  className="fm-viewport-3d-toolbar__button fm-viewport-3d-toolbar__segment-item"
                  data-active={isActive ? "true" : "false"}
                  data-testid={testId}
                  onClick={() => setTextureGizmoMode(mode)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Icon aria-hidden="true" size={ICON_SIZE} />
                </Button>
              </ToolbarTooltip>
            );
          })}
        </div>

        <ToolbarSeparator />

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
            <ToolbarTooltip content={`Standard views and navigation (${cameraMode.label})`}>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Camera: ${cameraMode.label}`}
                  className="fm-viewport-3d-toolbar__button fm-viewport-3d-toolbar__menu-button"
                  data-camera-mode={cameraMode.value}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <CameraModeIcon aria-hidden="true" size={ICON_SIZE} />
                  <span className="fm-viewport-3d-toolbar__label">Camera</span>
                  <ChevronDown aria-hidden="true" className="fm-viewport-3d-toolbar__chevron" size={12} />
                </Button>
              </DropdownMenuTrigger>
            </ToolbarTooltip>
            <DropdownMenuContent align="start" className="fm-viewport-3d-toolbar__menu">
              <DropdownMenuLabel>Standard views</DropdownMenuLabel>
              <div className="fm-viewport-3d-toolbar__view-grid">
                {VIEW_DIRECTION_COMMANDS.map((command) => (
                  <DropdownMenuItem
                    aria-description={command.title}
                    key={command.id}
                    onSelect={() => onCommand(command.id)}
                  >
                    {command.label}
                  </DropdownMenuItem>
                ))}
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Navigation</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={widgets.rotationMode}
                onValueChange={(value) => {
                  if (value === "object" || value === "camera") viewport3dStore.setRotationMode(value);
                }}
              >
                {CAMERA_MODES.map(({ description, icon: Icon, label, value }) => (
                  <DropdownMenuRadioItem className="fm-viewport-3d-toolbar__option" key={value} value={value}>
                    <Icon aria-hidden="true" data-icon size={ICON_SIZE} />
                    <span className="fm-viewport-3d-toolbar__option-name">{label}</span>
                    <span className="fm-viewport-3d-toolbar__option-summary">{description}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

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
              variant="ghost"
            >
              <Box aria-hidden="true" size={ICON_SIZE} />
              <span aria-hidden="true" className="fm-viewport-3d-toolbar__current">
                {projectionLabel}
              </span>
            </Button>
          </ToolbarTooltip>
        </div>

        <ToolbarSeparator />

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
              variant="ghost"
            >
              <Eye aria-hidden="true" size={ICON_SIZE} />
              <span className="fm-viewport-3d-toolbar__label">Inspect</span>
            </Button>
          </ToolbarTooltip>

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

        <ToolbarSeparator />

        <div aria-label="Appearance" className="fm-viewport-3d-toolbar__group" role="group">
          <DropdownMenu modal={false}>
            <ToolbarTooltip content={appearanceLabel}>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={appearanceLabel}
                  className="fm-viewport-3d-toolbar__button fm-viewport-3d-toolbar__menu-button"
                  data-render-mode={renderMode.value}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <RenderModeIcon aria-hidden="true" size={ICON_SIZE} />
                  <span aria-hidden="true" className="fm-viewport-3d-toolbar__current">
                    {renderMode.label}, {qualityLabel}
                  </span>
                  <ChevronDown aria-hidden="true" className="fm-viewport-3d-toolbar__chevron" size={12} />
                </Button>
              </DropdownMenuTrigger>
            </ToolbarTooltip>
            <DropdownMenuContent align="center" className="fm-viewport-3d-toolbar__menu">
              <DropdownMenuLabel>Render mode</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={appearance.renderMode}
                onValueChange={(value) => {
                  if (value === "scientific" || value === "presentation") {
                    selectViewport3DRenderMode(appearance.renderMode, value);
                  }
                }}
              >
                {RENDER_MODES.map(({ description, icon: Icon, label, value }) => (
                  <DropdownMenuRadioItem className="fm-viewport-3d-toolbar__option" key={value} value={value}>
                    <Icon aria-hidden="true" data-icon size={ICON_SIZE} />
                    <span className="fm-viewport-3d-toolbar__option-name">{label}</span>
                    <span className="fm-viewport-3d-toolbar__option-summary">{description}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
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
                    aria-description={VIEWPORT_3D_QUALITY_PROFILE_DESCRIPTIONS[id]}
                    className="fm-viewport-3d-toolbar__option"
                    key={id}
                    value={id}
                  >
                    <span className="fm-viewport-3d-toolbar__option-name">{label}</span>
                    <span className="fm-viewport-3d-toolbar__option-summary">
                      {VIEWPORT_3D_QUALITY_PROFILE_SUMMARIES[id]}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <ToolbarSeparator collapsible />

        <div
          aria-label="Output"
          className="fm-viewport-3d-toolbar__group"
          data-collapsible="true"
          role="group"
        >
          <DropdownMenu modal={false}>
            <ToolbarTooltip content="Export the current view">
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label="Export"
                  className="fm-viewport-3d-toolbar__button"
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Download aria-hidden="true" size={ICON_SIZE} />
                  <span className="fm-viewport-3d-toolbar__label">Export</span>
                </Button>
              </DropdownMenuTrigger>
            </ToolbarTooltip>
            <DropdownMenuContent align="end" className="fm-viewport-3d-toolbar__menu">
              <ExportMenuItems onCommand={onCommand} />
            </DropdownMenuContent>
          </DropdownMenu>

          <ToolbarTooltip content="Open view settings">
            <Button
              aria-label="View settings"
              aria-pressed={settingsOpen}
              className="fm-viewport-3d-toolbar__button"
              data-command-id="viewport-3d.toggle-settings"
              onClick={() => onCommand("viewport-3d.toggle-settings")}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Settings aria-hidden="true" size={ICON_SIZE} />
              <span className="fm-viewport-3d-toolbar__label">Settings</span>
            </Button>
          </ToolbarTooltip>
        </div>

        {/* Visible only when a container query folds the Output group. */}
        <DropdownMenu modal={false}>
          <ToolbarTooltip content="More view tools">
            <DropdownMenuTrigger asChild>
              <Button
                aria-label="More view tools"
                className="fm-viewport-3d-toolbar__button fm-viewport-3d-toolbar__more"
                size="icon"
                type="button"
                variant="ghost"
              >
                <Ellipsis aria-hidden="true" size={ICON_SIZE} />
              </Button>
            </DropdownMenuTrigger>
          </ToolbarTooltip>
          <DropdownMenuContent align="end" className="fm-viewport-3d-toolbar__menu">
            <ExportMenuItems onCommand={onCommand} />
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={settingsOpen}
              onCheckedChange={() => onCommand("viewport-3d.toggle-settings")}
            >
              View settings
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TooltipProvider>
  );
}

function ExportMenuItems({ onCommand }: { onCommand: (id: string) => void }) {
  return (
    <>
      <DropdownMenuLabel>Export view</DropdownMenuLabel>
      <DropdownMenuItem
        data-command-id="viewport-3d.capture-frame"
        onSelect={() => onCommand("viewport-3d.capture-frame")}
      >
        <Camera aria-hidden="true" data-icon size={ICON_SIZE} />
        Export PNG
      </DropdownMenuItem>
      <DropdownMenuItem
        data-command-id="viewport-3d.export-model"
        onSelect={() => onCommand("viewport-3d.export-model")}
      >
        <Download aria-hidden="true" data-icon size={ICON_SIZE} />
        Export 3D model
      </DropdownMenuItem>
    </>
  );
}

function ToolbarSeparator({ collapsible = false }: { collapsible?: boolean }) {
  return (
    <Separator
      className="fm-viewport-3d-toolbar__separator"
      data-collapsible={collapsible || undefined}
      orientation="vertical"
    />
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
