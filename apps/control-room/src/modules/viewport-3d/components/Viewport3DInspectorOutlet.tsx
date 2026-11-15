"use client";

import { useCallback, useRef } from "react";
import { registerViewport3DInspectorHost } from "../viewport3dInspectorState";

export function Viewport3DInspectorOutlet() {
  const release = useRef<(() => void) | null>(null);
  const ref = useCallback((host: HTMLDivElement | null) => {
    release.current?.();
    release.current = host ? registerViewport3DInspectorHost(host) : null;
  }, []);
  return <div className="fm-viewport-inspector-outlet" ref={ref}><p className="fm-viewport-inspector-outlet__placeholder">Open the 3D viewport to adjust its view settings.</p></div>;
}
