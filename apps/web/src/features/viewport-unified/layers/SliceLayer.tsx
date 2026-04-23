"use client";

import type { ReactNode } from "react";

export interface SliceLayerProps {
  visible?: boolean;
  children?: ReactNode;
}

export function SliceLayer({ visible = true, children = null }: SliceLayerProps) {
  if (!visible) {
    return <>{children}</>;
  }
  return <div data-viewport-layer="slice">{children}</div>;
}
