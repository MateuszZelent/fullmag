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
  return (
    <div className="h-full min-h-0 w-full" data-viewport-layer="explicit-topology">
      {children}
    </div>
  );
}
