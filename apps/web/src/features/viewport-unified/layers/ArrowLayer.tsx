"use client";

import type { ReactNode } from "react";

export interface ArrowLayerProps {
  visible?: boolean;
  children?: ReactNode;
}

export function ArrowLayer({ visible = true, children = null }: ArrowLayerProps) {
  if (!visible) {
    return <>{children}</>;
  }
  return <div data-viewport-layer="arrows">{children}</div>;
}
