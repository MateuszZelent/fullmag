"use client";

import type { ReactNode } from "react";

export interface MeshLayerProps {
  visible?: boolean;
  children?: ReactNode;
}

export function MeshLayer({ visible = true, children = null }: MeshLayerProps) {
  return (
    <div
      className="flex flex-col flex-1 h-full min-h-0 min-w-0 w-full"
      data-viewport-layer="explicit-topology"
      data-viewport-layer-visible={visible ? "true" : "false"}
    >
      {children}
    </div>
  );
}
