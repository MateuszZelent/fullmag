"use client";

import { Box, ChevronDown, Crosshair, Eye, Settings2, Sparkles, Target } from "lucide-react";

import type { Selection } from "@/kernel/selection/selectionTypes";
import type { VisualizationTargetRef } from "@/kernel/visualization/ObjectVisualizationController";
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

import {
  RIBBON_INSPECTOR_OPEN_AIRBOX_SETTINGS_COMMAND,
  RIBBON_INSPECTOR_OPEN_MAGNETIC_TEXTURE_COMMAND,
  RIBBON_INSPECTOR_OPEN_VISUALIZATION_COMMAND,
  RIBBON_SELECTION_SELECT_TARGET_COMMAND,
  openMagneticTextureInspectorCommandInput,
  openVisualizationInspectorCommandInput,
  selectRibbonTargetCommandInput,
} from "./ribbonCommands";
import {
  activeViewTargetSummary,
  resolveSceneObjectLabel,
  type RibbonSceneObjectEntry,
} from "./ribbonTargetContext";
import type { RibbonTabId } from "./ribbonTypes";

function targetTabForCommand(
  activeTab: RibbonTabId,
): "view" | "geometry" | "materials" | "physics" | "mesh" | undefined {
  if (
    activeTab === "view" ||
    activeTab === "geometry" ||
    activeTab === "materials" ||
    activeTab === "physics" ||
    activeTab === "mesh"
  ) {
    return activeTab;
  }
  return undefined;
}

export function RibbonTargetBarControl({
  activeTab,
  discretization,
  sceneObjects,
  selection,
  visualizationTarget,
  onAction,
}: {
  activeTab: RibbonTabId;
  discretization: "fdm" | "fem" | "unknown";
  sceneObjects: readonly RibbonSceneObjectEntry[];
  selection: Selection;
  visualizationTarget: VisualizationTargetRef | null;
  onAction: (actionId: string, input?: unknown) => void;
}) {
  const orderedIds =
    selection.selectedObjectIds && selection.selectedObjectIds.length > 0
      ? [...selection.selectedObjectIds]
      : selection.objectId
        ? [selection.objectId]
        : [];
  const isMulti = orderedIds.length >= 2;
  const baseLabel = isMulti
    ? resolveSceneObjectLabel(orderedIds[0], sceneObjects, selection.label) ?? orderedIds[0]
    : null;
  const toolLabels = isMulti
    ? orderedIds.slice(1).map((id) => resolveSceneObjectLabel(id, sceneObjects) ?? id)
    : [];

  const viewSummary = activeViewTargetSummary(visualizationTarget, sceneObjects);
  const selectedObject =
    !viewSummary.isAirbox && selection.objectId
      ? sceneObjects.find((entry) => entry.id === selection.objectId) ?? {
          id: selection.objectId,
          label: selection.label ?? selection.objectId,
          role: "magnet" as const,
        }
      : viewSummary.objectEntry;
  const regionId =
    selection.ref?.type === "scene-object" ? selection.ref.regionId ?? null : null;

  const prefix = isMulti
    ? "CSG"
    : activeTab === "mesh" && discretization === "fdm" && !selectedObject && !viewSummary.isAirbox
      ? "Scope"
      : "Target";
  const displayValue = isMulti
    ? `Base [A]: ${baseLabel} · Tools [B]: ${toolLabels.join(", ")}`
    : viewSummary.isAirbox
      ? "Airbox (Universe)"
      : selectedObject
        ? regionId
          ? `${selectedObject.label} / ${regionId}`
          : selectedObject.label
        : activeTab === "mesh" && discretization === "fdm"
          ? "Shared FDM Grid"
          : "All Objects";

  const radioValue = viewSummary.isAirbox
    ? "airbox"
    : selectedObject
      ? `object:${selectedObject.id}`
      : "__all__";

  const tabScope = targetTabForCommand(activeTab);
  const TriggerIcon = isMulti ? Crosshair : viewSummary.isAirbox ? Box : Target;
  const titleText = isMulti
    ? `Active Boolean CSG operands — Base [A]: ${baseLabel} · Tools [B]: ${toolLabels.join(", ")}`
    : `Active ribbon target: ${displayValue}. Click to switch target for View, Geometry, Materials, Physics, and Mesh.`;

  const handleSelectValue = (value: string) => {
    if (value === "__all__") {
      onAction(
        RIBBON_SELECTION_SELECT_TARGET_COMMAND,
        selectRibbonTargetCommandInput({ targetKind: "all", tab: tabScope }),
      );
      return;
    }
    if (value === "airbox") {
      onAction(
        RIBBON_SELECTION_SELECT_TARGET_COMMAND,
        selectRibbonTargetCommandInput({ targetKind: "airbox", tab: tabScope }),
      );
      return;
    }
    if (value.startsWith("object:")) {
      const objectId = value.slice("object:".length);
      const entry = sceneObjects.find((item) => item.id === objectId);
      onAction(
        RIBBON_SELECTION_SELECT_TARGET_COMMAND,
        selectRibbonTargetCommandInput({
          objectId,
          objectLabel: entry?.label ?? objectId,
          objectRole: entry?.role ?? "magnet",
          tab: tabScope,
          targetKind: "object",
        }),
      );
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={`Active ribbon target: ${displayValue}`}
          className="fm-ribbon-density"
          data-ribbon-target-bar="true"
          data-target-kind={
            isMulti
              ? "multi"
              : viewSummary.isAirbox
                ? "airbox"
                : selectedObject
                  ? "object"
                  : "all"
          }
          size="sm"
          style={{
            maxWidth: "240px",
            border: "1px solid var(--fm-border-default)",
            background: "var(--fm-bg-panel-raised)",
          }}
          title={titleText}
          type="button"
          variant="ghost"
        >
          <TriggerIcon
            aria-hidden="true"
            size={15}
            style={{
              flexShrink: 0,
              color: viewSummary.isAirbox
                ? "var(--fm-category-runtime)"
                : isMulti
                  ? "var(--fm-category-solver)"
                  : "var(--fm-accent-strong)",
            }}
          />
          <span style={{ flexShrink: 0 }}>{prefix}:</span>
          <span
            className="fm-ribbon-density__value"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {displayValue}
          </span>
          <ChevronDown aria-hidden="true" size={14} style={{ flexShrink: 0 }} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="fm-ribbon-menu">
        <DropdownMenuLabel>
          <span>Active Ribbon Target</span>
          {isMulti ? (
            <span className="fm-dropdown-badge">{orderedIds.length} selected</span>
          ) : null}
        </DropdownMenuLabel>
        {isMulti ? (
          <>
            <div className="fm-ribbon-menu-status" data-tone="success">
              <span>Base [A]</span>
              <span>{baseLabel}</span>
            </div>
            <div className="fm-ribbon-menu-status" data-tone="neutral">
              <span>Tools [B]</span>
              <span>{toolLabels.join(", ")}</span>
            </div>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuRadioGroup value={radioValue} onValueChange={handleSelectValue}>
          <DropdownMenuRadioItem value="__all__">
            All Objects (Default)
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="airbox">
            Airbox (Universe)
          </DropdownMenuRadioItem>
          {sceneObjects.map((entry) => (
            <DropdownMenuRadioItem key={entry.id} value={`object:${entry.id}`}>
              {entry.role === "magnet" ? entry.label : `${entry.label} (${entry.role})`}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {viewSummary.isAirbox ? (
          <DropdownMenuItem
            onSelect={() =>
              onAction(
                RIBBON_INSPECTOR_OPEN_VISUALIZATION_COMMAND,
                openVisualizationInspectorCommandInput({ targetKind: "airbox" }),
              )
            }
          >
            <Eye aria-hidden="true" size={14} />
            <span>Open Airbox Visualization</span>
          </DropdownMenuItem>
        ) : selectedObject ? (
          <DropdownMenuItem
            onSelect={() =>
              onAction(
                RIBBON_INSPECTOR_OPEN_VISUALIZATION_COMMAND,
                openVisualizationInspectorCommandInput({
                  objectId: selectedObject.id,
                  objectLabel: selectedObject.label,
                  objectRole: selectedObject.role,
                  targetKind: "object",
                }),
              )
            }
          >
            <Eye aria-hidden="true" size={14} />
            <span>Open {selectedObject.label} Visualization</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={() => onAction(RIBBON_INSPECTOR_OPEN_AIRBOX_SETTINGS_COMMAND)}
        >
          <Settings2 aria-hidden="true" size={14} />
          <span>Open Airbox Settings</span>
        </DropdownMenuItem>
        {selectedObject && selectedObject.role === "magnet" ? (
          <DropdownMenuItem
            onSelect={() =>
              onAction(
                RIBBON_INSPECTOR_OPEN_MAGNETIC_TEXTURE_COMMAND,
                openMagneticTextureInspectorCommandInput({
                  objectId: selectedObject.id,
                  objectLabel: selectedObject.label,
                  objectRole: selectedObject.role,
                }),
              )
            }
          >
            <Sparkles aria-hidden="true" size={14} />
            <span>Open {selectedObject.label} Magnetic Texture</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
