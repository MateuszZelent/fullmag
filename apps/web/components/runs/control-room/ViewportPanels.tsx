"use client";

import { memo } from "react";

import { useViewportDataBridge } from "@/features/viewport-unified/hooks/useViewportDataBridge";
import { ViewportTabContent } from "@/features/viewport-unified/renderers/ViewportTabContent";

export { ViewportBar } from "./ViewportBar";

export const ViewportCanvasArea = memo(function ViewportCanvasArea() {
  const bridge = useViewportDataBridge();
  return <ViewportTabContent bridge={bridge} />;
});
