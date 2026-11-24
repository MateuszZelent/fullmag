"use client";

import { Maximize2, Minimize2 } from "lucide-react";

import {
  toggleWorkspaceFullscreen,
  useWorkspaceFullscreen,
} from "./workspaceFullscreenPreference";

export interface WorkspaceFullscreenButtonProps {
  readonly variant?: "header" | "strip" | "floating";
}

export function WorkspaceFullscreenButton({
  variant = "header",
}: WorkspaceFullscreenButtonProps) {
  const fullscreen = useWorkspaceFullscreen();
  const Icon = fullscreen ? Minimize2 : Maximize2;
  const tooltip = fullscreen
    ? "Exit full screen mode — restore header and footer (Alt+Shift+F)"
    : "Full screen mode — minimize header and footer (Alt+Shift+F)";

  return (
    <button
      aria-label="Full screen workspace"
      aria-pressed={fullscreen}
      className="fm-header__fullscreen-toggle"
      data-fullscreen-variant={variant}
      title={tooltip}
      type="button"
      onClick={() => toggleWorkspaceFullscreen()}
    >
      <Icon aria-hidden="true" size={14} />
    </button>
  );
}
