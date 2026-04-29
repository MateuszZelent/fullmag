"use client";

import type { ReactNode } from "react";

export interface BoundsLayerProps {
  visible?: boolean;
  children?: ReactNode;
}

export function BoundsLayer({ visible = true, children = null }: BoundsLayerProps) {
  return (
    <div
      className="h-full min-h-0 w-full"
      data-viewport-layer="bounds"
      data-viewport-layer-visible={visible ? "true" : "false"}
    >
      {children}
    </div>
  );
}
