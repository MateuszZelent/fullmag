"use client";

import type { ReactNode } from "react";

export interface MeshLayerProps {
  visible?: boolean;
  children?: ReactNode;
}

export function MeshLayer({ visible = true, children = null }: MeshLayerProps) {
  if (!visible) {
    return <>{children}</>;
  }
  return <div data-viewport-layer="mesh">{children}</div>;
}
