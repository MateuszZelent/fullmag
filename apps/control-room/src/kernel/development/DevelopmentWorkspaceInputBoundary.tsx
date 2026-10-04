"use client";

import type { ReactNode } from "react";
import { useDevelopmentWorkspacePaused } from "./useDevelopmentWorkspacePaused";

export function DevelopmentWorkspaceInputBoundary({ children, className }: { children: ReactNode; className?: string }) {
  const paused = useDevelopmentWorkspacePaused();
  return <main className={className} inert={paused} aria-busy={paused}>{children}</main>;
}
