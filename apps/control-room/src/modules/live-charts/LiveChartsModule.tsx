"use client";

import type { ModuleProps } from "@/kernel/types";
import { LiveChartsView } from "./LiveChartsView";
import { useLiveChartsController } from "./useLiveChartsController";

export { LiveChartsView } from "./LiveChartsView";

export default function LiveChartsModule({ kernel }: ModuleProps) {
  const controller = useLiveChartsController(kernel.selection);
  return <LiveChartsView {...controller} />;
}
