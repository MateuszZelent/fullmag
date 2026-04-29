"use client";

import type { ReactNode } from "react";

export interface WireframeLayerProps {
  visible?: boolean;
  children?: ReactNode;
}

export function WireframeLayer({ visible = true, children = null }: WireframeLayerProps) {
  return (
    <div
      className="h-full min-h-0 w-full"
      data-viewport-layer="wireframe"
      data-viewport-layer-visible={visible ? "true" : "false"}
    >
      {children}
    </div>
  );
}
