"use client";

import { SegmentedControl } from "@/shared/ui/SegmentedControl";

import { selectViewport3DRenderMode, useViewport3DCommandState } from "../viewport3dStore";

const VISUALIZATION_MODE_OPTIONS = [
  { label: "Scientific", value: "scientific" },
  { label: "Presentation", value: "presentation" },
] as const;

export function Viewport3DVisualizationModeControl() {
  const { appearance } = useViewport3DCommandState();

  return (
    <fieldset className="fm-viewport-3d-settings__group fm-viewport-3d__settings-section">
      <legend className="fm-viewport-3d-settings__legend">Visualization mode</legend>
      <div className="fm-viewport-3d-settings__field-list">
        <SegmentedControl
          aria-label="Visualization mode"
          columns={2}
          options={VISUALIZATION_MODE_OPTIONS}
          value={appearance.renderMode}
          onValueChange={(renderMode) => selectViewport3DRenderMode(appearance.renderMode, renderMode)}
        />
        <p className="fm-viewport-3d-settings__help">
          Scientific preserves exact field colors. Presentation shades field colors to reveal shape; use Scientific for quantitative color reading.
        </p>
      </div>
    </fieldset>
  );
}
