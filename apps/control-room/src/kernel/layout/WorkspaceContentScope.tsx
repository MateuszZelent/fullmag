"use client";

import { createContext, useContext, type ReactNode } from "react";

export type WorkspaceContentScope = "project" | "session";

// Presentation scope is derived by the shell; it is not runtime capability
// or another global state store. Session remains the existing default.
const WorkspaceContentScopeContext = createContext<WorkspaceContentScope>("session");

export function WorkspaceContentScopeProvider({
  children,
  scope,
}: {
  children: ReactNode;
  scope: WorkspaceContentScope;
}) {
  return (
    <WorkspaceContentScopeContext.Provider value={scope}>
      {children}
    </WorkspaceContentScopeContext.Provider>
  );
}

export function useWorkspaceContentScope(): WorkspaceContentScope {
  return useContext(WorkspaceContentScopeContext);
}
