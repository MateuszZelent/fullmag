"use client";

import { ViewportStatusChip } from "../ViewportStatusChips";

export interface FemViewportStatusBarProps {
  compact?: boolean;
  surfaceLabel: string;
  arrowLabel: string;
  arrowDensity: number;
  effectiveDensity: number;
  renderModeMixed?: boolean;
  opacityMixed?: boolean;
  colorFieldMixed?: boolean;
  toolbarScopeLabel?: string | null;
  arrowsRequested?: boolean;
  arrowsVisible?: boolean;
  arrowsBlockReason?: string | null;
  interactionSimplified?: boolean;
  hasField?: boolean;
  fieldLabel?: string;
  visiblePartsCount?: number;
  totalPartsCount?: number;
}

export function FemViewportStatusBar({
  surfaceLabel,
  arrowLabel,
  arrowDensity,
  effectiveDensity,
  renderModeMixed = false,
  opacityMixed = false,
  colorFieldMixed = false,
  toolbarScopeLabel = null,
  arrowsRequested = false,
  arrowsVisible = false,
  arrowsBlockReason = null,
  interactionSimplified = false,
  hasField,
  fieldLabel,
  visiblePartsCount,
  totalPartsCount,
}: FemViewportStatusBarProps) {
  return (
    <div className="pointer-events-none flex flex-wrap items-center justify-center gap-1.5">
      <ViewportStatusChip color="primary" active>
        Surf {surfaceLabel}
      </ViewportStatusChip>
      <ViewportStatusChip color="primary" active>
        Arr {arrowLabel}
      </ViewportStatusChip>
      <ViewportStatusChip color={effectiveDensity < arrowDensity ? "warning" : "default"} active>
        Vec {arrowDensity}
        {effectiveDensity !== arrowDensity ? `->${effectiveDensity}` : ""}
      </ViewportStatusChip>
      {renderModeMixed && (
        <ViewportStatusChip color="warning" active>
          <span title="Visible parts have different render modes">Mixed mode</span>
        </ViewportStatusChip>
      )}
      {opacityMixed && (
        <ViewportStatusChip color="warning" active>
          <span title="Visible parts have different opacity values">Mixed opacity</span>
        </ViewportStatusChip>
      )}
      {colorFieldMixed && (
        <ViewportStatusChip color="warning" active>
          <span title="Visible parts have different color fields">Mixed color</span>
        </ViewportStatusChip>
      )}
      {toolbarScopeLabel && (
        <ViewportStatusChip color="info" active>
          <span title="Toolbar controls apply to this scope">{toolbarScopeLabel}</span>
        </ViewportStatusChip>
      )}
      {arrowsRequested && !arrowsVisible && arrowsBlockReason && (
        <ViewportStatusChip color="warning" active>
          <span title={arrowsBlockReason}>Vectors blocked</span>
        </ViewportStatusChip>
      )}
      {interactionSimplified && (
        <ViewportStatusChip color="default" active>
          <span title="Render quality reduced during camera interaction">Simplified</span>
        </ViewportStatusChip>
      )}
      {hasField && (
        <ViewportStatusChip color="info">{fieldLabel ?? "M"}</ViewportStatusChip>
      )}
      {visiblePartsCount !== undefined && totalPartsCount !== undefined && (
        <ViewportStatusChip color="default">
          {visiblePartsCount}/{totalPartsCount} parts
        </ViewportStatusChip>
      )}
    </div>
  );
}
