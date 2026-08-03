"use client";

import { useEffect } from "react";

import type { ModuleProps } from "@/kernel/types";
import { LiveChartsView } from "./LiveChartsView";
import { ensureLiveChartsInspectorVisible, useLiveChartsController } from "./useLiveChartsController";

export { LiveChartsView } from "./LiveChartsView";

export default function LiveChartsModule({ kernel }: ModuleProps) {
  const controller = useLiveChartsController(kernel.selection);
  useEffect(() => {
    ensureLiveChartsInspectorVisible(kernel, controller.descriptorId);
  }, [controller.descriptorId, kernel]);
  return <LiveChartsView {...controller} />;
}
