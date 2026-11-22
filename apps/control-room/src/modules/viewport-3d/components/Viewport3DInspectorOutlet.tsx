"use client";

import { useCallback, useRef } from "react";
import {
  registerViewport3DExportHost,
  registerViewport3DInspectorHost,
} from "../viewport3dInspectorState";
import {
  Viewport3DExportPlaceholder,
  Viewport3DSettingsPlaceholder,
} from "./Viewport3DSettingsAndExportSpecs";

export function Viewport3DInspectorOutlet() {
  const release = useRef<(() => void) | null>(null);
  const ref = useCallback((host: HTMLDivElement | null) => {
    release.current?.();
    release.current = host ? registerViewport3DInspectorHost(host) : null;
  }, []);
  return (
    <div className="fm-viewport-inspector-outlet" ref={ref}>
      <div className="fm-viewport-inspector-outlet__placeholder">
        <Viewport3DSettingsPlaceholder />
      </div>
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
      <div className="fm-viewport-inspector-outlet__placeholder">
        <Viewport3DExportPlaceholder />
      </div>
    </div>
  );
}
