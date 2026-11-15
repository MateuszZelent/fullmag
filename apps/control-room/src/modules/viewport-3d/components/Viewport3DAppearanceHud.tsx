"use client";

import { useViewport3DCommandState } from "../viewport3dStore";

export function Viewport3DAppearanceHud() {
  const { appearance, captureError, widgets } = useViewport3DCommandState();
  return <>
    {widgets.dimensionFrameMode !== "off" ? <span title={appearance.dimensionOrigin === "world" ? "Tick values are absolute world coordinates in the displayed unit." : "Tick values are relative to the center of the displayed reference frame."}>Origin: {appearance.dimensionOrigin === "world" ? "world" : "frame center"}</span> : null}
    {captureError ? <span role="alert">Image export failed: {captureError}</span> : null}
  </>;
}
