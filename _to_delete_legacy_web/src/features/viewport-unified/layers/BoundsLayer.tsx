"use client";

import type { ReactNode } from "react";

export interface BoundsLayerProps {
  visible?: boolean;
  children?: ReactNode;
}

export function BoundsLayer({ visible = true, children = null }: BoundsLayerProps) {
  return (
    <div
      className="flex flex-col flex-1 h-full min-h-0 min-w-0 w-full"
      data-viewport-layer="bounds"
      data-viewport-layer-visible={visible ? "true" : "false"}
    >
      {children}
    </div>
  );
}
