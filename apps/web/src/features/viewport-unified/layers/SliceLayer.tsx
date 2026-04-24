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
  return (
    <div className="h-full min-h-0 w-full" data-viewport-layer="slice">
      {children}
    </div>
  );
}
