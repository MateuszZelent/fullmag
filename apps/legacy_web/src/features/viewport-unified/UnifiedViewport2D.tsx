"use client";

import { memo, type ReactNode } from "react";

export interface UnifiedViewport2DProps {
  children?: ReactNode;
  fallback?: ReactNode;
}

const UnifiedViewport2D = memo(function UnifiedViewport2D({
  children,
  fallback = null,
}: UnifiedViewport2DProps) {
  return <>{children ?? fallback}</>;
});

export default UnifiedViewport2D;
