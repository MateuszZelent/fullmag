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
  return (
    <div className="h-full min-h-0 w-full" data-viewport-layer="vector-field">
      {children}
    </div>
  );
}
