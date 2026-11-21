"use client";

import { useCallback, useRef } from "react";
import {
  registerViewport3DExportHost,
  registerViewport3DInspectorHost,
} from "../viewport3dInspectorState";

export function Viewport3DInspectorOutlet() {
  const release = useRef<(() => void) | null>(null);
  const ref = useCallback((host: HTMLDivElement | null) => {
    release.current?.();
    release.current = host ? registerViewport3DInspectorHost(host) : null;
  }, []);
  return (
    <div className="fm-viewport-inspector-outlet" ref={ref}>
      <p className="fm-viewport-inspector-outlet__placeholder">
        Open the 3D viewport to adjust its view settings.
      </p>
    </div>
  );
}

export function Viewport3DExportPanelOutlet() {
  const release = useRef<(() => void) | null>(null);
  const ref = useCallback((host: HTMLDivElement | null) => {
    release.current?.();
    release.current = host ? registerViewport3DExportHost(host) : null;
  }, []);
  return (
    <div className="fm-viewport-inspector-outlet" ref={ref}>
      <p className="fm-viewport-inspector-outlet__placeholder">
        Open the 3D viewport to export a PNG image or 3D model.
      </p>
    </div>
  );
}
