"use client";

import type { ReactNode } from "react";

export interface WireframeLayerProps {
  visible?: boolean;
  children?: ReactNode;
}

export function WireframeLayer({ visible = true, children = null }: WireframeLayerProps) {
  if (!visible) {
    return <>{children}</>;
  }
  return <div data-viewport-layer="wireframe">{children}</div>;
}
