"use client";

import type { ModuleProps } from "@/kernel/types";
import { LiveChartsView } from "./LiveChartsView";
import { useLiveChartsController } from "./useLiveChartsController";

export { LiveChartsView } from "./LiveChartsView";

export default function LiveChartsModule(_props: ModuleProps) {
  const controller = useLiveChartsController();
  return <LiveChartsView {...controller} />;
}
