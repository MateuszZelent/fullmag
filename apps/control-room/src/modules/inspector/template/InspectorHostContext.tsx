"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { InspectorDescriptor } from "../inspectorDescriptor";

export type InspectorHostBreadcrumbSelection = NonNullable<
  InspectorDescriptor["breadcrumbs"][number]["selection"]
>;

export interface InspectorHostContextValue {
  descriptor: InspectorDescriptor;
  focusDisabled: boolean;
  onFocus: () => void;
  onSelectBreadcrumb: (selection: InspectorHostBreadcrumbSelection) => void;
  onToggleVisibility: () => void;
}

const InspectorHostContext = createContext<InspectorHostContextValue | null>(null);

export function InspectorHostProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: InspectorHostContextValue;
}): ReactNode {
  return (
    <InspectorHostContext.Provider value={value}>
      {children}
    </InspectorHostContext.Provider>
  );
}

export function useInspectorHostContext(): InspectorHostContextValue | null {
  return useContext(InspectorHostContext);
}
