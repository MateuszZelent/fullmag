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
  return (
    <div className="h-full min-h-0 w-full" data-viewport-layer="wireframe">
      {children}
    </div>
  );
}
