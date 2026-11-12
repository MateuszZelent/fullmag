"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import {
  Camera,
  ChartSpline,
  CircleDashed,
  Crop,
  Crosshair,
  Ellipsis,
  FileDown,
  Grip,
  Hand,
  LayoutGrid,
  Maximize,
  MoveUpRight,
  Palette,
  Ruler,
  ScanSearch,
  Triangle,
  Waves,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { useKernel } from "@/kernel/KernelContext";
import { createCommandContext } from "@/kernel/commands/commandContext";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import { fieldMapSurfaceStore } from "@/kernel/visualization/fieldMapSurfaceStore";
import { usePlanarActiveTool } from "@/kernel/visualization/planarToolStore";
import { Button } from "@/shared/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/DropdownMenu";
import { Separator } from "@/shared/ui/Separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/ui/Tooltip";

import { MULTISLICE_MAX_PANELS, MULTISLICE_MIN_PANELS } from "../model/planarMultislice";

interface ToolbarItem {
  commandId: string;
  icon: ReactNode;
  label: string;
  /** Key shown in the tooltip; the registered shortcut when one exists. */
  keyHint?: string;
}

const ICON_SIZE = 16;
const icon = (Icon: typeof Hand) => <Icon aria-hidden="true" size={ICON_SIZE} strokeWidth={1.75} />;

const TOOLS: readonly ToolbarItem[] = [
  { commandId: "field-map.tool.navigate", icon: icon(Hand), label: "Navigate" },
  { commandId: "field-map.tool.zoom-box", icon: icon(ScanSearch), label: "Zoom to box" },
  { commandId: "field-map.tool.crop", icon: icon(Crop), label: "Crop" },
  { commandId: "field-map.tool.inspect", icon: icon(Crosshair), label: "Inspect node" },
  { commandId: "field-map.tool.profile", icon: icon(ChartSpline), label: "Line profile" },
  { commandId: "field-map.tool.measure", icon: icon(Ruler), label: "Measure" },
];

const NAVIGATION: readonly ToolbarItem[] = [
  // `+` and `-` act on the focused canvas; the shortcut parser reserves `+`.
  { commandId: "field-map.zoom-in", icon: icon(ZoomIn), label: "Zoom in", keyHint: "+" },
  { commandId: "field-map.zoom-out", icon: icon(ZoomOut), label: "Zoom out", keyHint: "−" },
  { commandId: "field-map.fit", icon: icon(Maximize), label: "Fit view" },
];

const MASKS: readonly ToolbarItem[] = [
  { commandId: "field-map.toggle-vectors", icon: icon(MoveUpRight), label: "Vectors" },
  { commandId: "field-map.toggle-points", icon: icon(Grip), label: "Sample points" },
  { commandId: "field-map.toggle-mesh", icon: icon(Triangle), label: "Mesh" },
  { commandId: "field-map.toggle-streamlines", icon: icon(Waves), label: "Field lines" },
  { commandId: "field-map.toggle-contours", icon: icon(CircleDashed), label: "Contours" },
  { commandId: "field-map.toggle-multislice", icon: icon(LayoutGrid), label: "Slice panels" },
  { commandId: "field-map.toggle-legend", icon: icon(Palette), label: "Legend" },
];

const EXPORTS: readonly ToolbarItem[] = [
  { commandId: "field-map.export-png", icon: icon(Camera), label: "Export PNG" },
  { commandId: "field-map.export-data", icon: icon(FileDown), label: "Export data (CSV)" },
];

const PANEL_COUNTS = Array.from(
  { length: MULTISLICE_MAX_PANELS - MULTISLICE_MIN_PANELS + 1 },
  (_, index) => String(MULTISLICE_MIN_PANELS + index),
);

/**
 * Compact key of the presented profile fields the toolbar shows. Pan and zoom
 * update the presented profile every frame; a primitive snapshot keeps the
 * toolbar from re-rendering for them.
 */
function toolbarStateKey(): string {
  const planar = fieldMapSurfaceStore.get().planar;
  if (!planar) return "";
  return JSON.stringify([
    planar.component,
    planar.source.kind,
    planar.field_overlays?.length ?? 0,
    planar.layers,
    planar.multislice?.enabled ?? false,
    planar.multislice?.position_fractions.length ?? 0,
    planar.viewport_colorbar_visible,
  ]);
}
const serverToolbarStateKey = () => "";
const serverCommandVersion = () => 0;

/**
 * Icon toolbar above the 2D canvas (plan §2.1 A, §2.2). It renders only
 * registered commands: tools, navigation, view masks and export. Enabled,
 * active and disabled-reason state come from the same contributions the
 * ribbon, shortcuts and command palette use; the toolbar holds no data props.
 */
export function PlanarToolbar() {
  const kernel = useKernel();
  const commands = kernel.commands;
  // Re-render when the tool, the shown masks or the registry change.
  usePlanarActiveTool();
  useSyncExternalStore(fieldMapSurfaceStore.subscribe, toolbarStateKey, serverToolbarStateKey);
  useSyncExternalStore(commands.subscribe.bind(commands), commands.getVersion.bind(commands), serverCommandVersion);
  const context = createCommandContext("ribbon", kernel, { sourceDetail: "field-map-toolbar" });
  const run = (commandId: string, input?: unknown) => {
    void commands.execute(commandId, context, input);
  };
  const planar = fieldMapSurfaceStore.get().planar;
  const multisliceEnabled = planar?.multislice?.enabled ?? false;
  const panelCount = String(planar?.multislice?.position_fractions.length ?? 3);
  const panelsEnabled = commands.isEnabled("field-map.multislice-panels", context);

  return (
    <TooltipProvider delayDuration={300}>
      <div aria-label="2D view tools" className="fm-planar-toolbar" role="toolbar">
        <div aria-label="Canvas tool" className="fm-planar-toolbar__group" role="radiogroup">
          {TOOLS.map((item) => (
            <ToolbarButton context={context} item={item} key={item.commandId} kind="radio" onRun={run} />
          ))}
        </div>
        <Separator className="fm-planar-toolbar__separator" orientation="vertical" />
        <div aria-label="Navigation" className="fm-planar-toolbar__group" role="group">
          {NAVIGATION.map((item) => (
            <ToolbarButton context={context} item={item} key={item.commandId} kind="action" onRun={run} />
          ))}
        </div>
        <Separator className="fm-planar-toolbar__separator" orientation="vertical" />
        <div aria-label="View layers" className="fm-planar-toolbar__group" role="group">
          {MASKS.map((item) => (
            <ToolbarButton context={context} item={item} key={item.commandId} kind="toggle" onRun={run} />
          ))}
        </div>
        <Separator className="fm-planar-toolbar__separator fm-planar-toolbar__export-separator" orientation="vertical" />
        <div aria-label="Export" className="fm-planar-toolbar__group fm-planar-toolbar__export" role="group">
          {EXPORTS.map((item) => (
            <ToolbarButton context={context} item={item} key={item.commandId} kind="action" onRun={run} />
          ))}
        </div>
        <span aria-hidden="true" className="fm-planar-toolbar__spacer" />
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button aria-label="More 2D view options" size="icon" type="button" variant="ghost">
              <Ellipsis aria-hidden="true" size={ICON_SIZE} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Slice panels</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={multisliceEnabled ? panelCount : ""}
              onValueChange={(value) => run("field-map.multislice-panels", { count: Number(value) })}
            >
              {PANEL_COUNTS.map((count) => (
                <DropdownMenuRadioItem disabled={!panelsEnabled} key={count} value={count}>
                  {`${count} panels`}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => run("field-map.reset-view")}>Reset view</DropdownMenuItem>
            {EXPORTS.map((item) => (
              <DropdownMenuItem
                disabled={!commands.isEnabled(item.commandId, context)}
                key={item.commandId}
                onSelect={() => run(item.commandId)}
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TooltipProvider>
  );
}

function ToolbarButton({
  context,
  item,
  kind,
  onRun,
}: {
  context: CommandContext;
  item: ToolbarItem;
  kind: "action" | "radio" | "toggle";
  onRun: (commandId: string) => void;
}) {
  const { commands } = useKernel();
  const command = commands.get(item.commandId);
  const enabled = command ? commands.isEnabled(item.commandId, context) : false;
  const active = command ? commands.isActive(item.commandId, context) : false;
  const reason = !command
    ? "This command is not available in this workspace."
    : enabled
      ? null
      : command.disabledReason?.(context) ?? "Unavailable for the current 2D view.";
  const shortcut = command?.shortcut ?? item.keyHint;
  const tooltip = shortcut ? `${item.label} (${shortcut})` : item.label;
  const stateProps = kind === "radio"
    ? { "aria-checked": active, role: "radio" as const }
    : kind === "toggle"
      ? { "aria-pressed": active }
      : {};
  const button = (
    <Button
      aria-keyshortcuts={command?.shortcut}
      aria-label={item.label}
      className="fm-planar-toolbar__button"
      data-active={active ? "" : undefined}
      data-command-id={item.commandId}
      disabled={!enabled}
      disabledReason={reason}
      size="icon"
      type="button"
      variant={active ? "primary" : "ghost"}
      onClick={() => onRun(item.commandId)}
      {...stateProps}
    >
      {item.icon}
    </Button>
  );
  // A disabled button explains itself through DisabledReason.
  if (!enabled) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
