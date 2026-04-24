"use client";

import type { ReactNode } from "react";

export interface BoundsLayerProps {
  visible?: boolean;
  children?: ReactNode;
}

export function BoundsLayer({ visible = true, children = null }: BoundsLayerProps) {
  if (!visible) {
    return <>{children}</>;
  }
  return (
    <div className="h-full min-h-0 w-full" data-viewport-layer="bounds">
      {children}
    </div>
  );
}
