import type { ComponentType, ReactNode } from "react";

import type { Selection } from "@/kernel/selection/selectionTypes";

export interface InspectorPanelProps {
  selection: Selection;
}

export interface InspectorPanelContribution {
  id: string;
  title: string;
  selectionKinds: string[];
  component: ComponentType<InspectorPanelProps>;
  description?: ReactNode;
}
