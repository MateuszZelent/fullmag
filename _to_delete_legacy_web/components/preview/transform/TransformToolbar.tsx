"use client";

import { useEffect } from "react";
import { useTransformMode } from "./TransformModeStore";
import type { TransformTool } from "./types";

const TOOL_ICONS: Record<TransformTool, { label: string; key: string }> = {
  select: { label: "⊡", key: "Q" },
  move: { label: "⇔", key: "W" },
  rotate: { label: "↻", key: "E" },
  scale: { label: "⤢", key: "R" },
};

/**
 * Transform toolbar — tool picker, space toggle, snap toggle.
 * Place alongside the viewport controls.
 */
export function TransformToolbar() {
  const { tool, space, snap, setTool, toggleSpace, toggleSnap } = useTransformMode();

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key.toUpperCase()) {
        case "Q": setTool("select"); break;
        case "W": if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); setTool("move"); } break;
        case "E": if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); setTool("rotate"); } break;
        case "R": if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); setTool("scale"); } break;
        case "X": if (!e.ctrlKey && !e.metaKey) toggleSpace(); break;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setTool, toggleSpace]);

  return (
    <div className="flex items-center gap-1 rounded-lg border border-slate-500/20 bg-slate-800/80 backdrop-blur-sm p-1">
      {(Object.entries(TOOL_ICONS) as [TransformTool, { label: string; key: string }][]).map(
        ([t, { label, key }]) => (
          <button
            key={t}
            className={`w-7 h-7 flex items-center justify-center rounded text-xs font-medium transition-colors ${
              tool === t
                ? "bg-primary text-primary-foreground"
                : "text-slate-300 hover:bg-slate-600/50"
            }`}
            onClick={() => setTool(t)}
            title={`${t} (${key})`}
          >
            {label}
          </button>
        ),
      )}

      <div className="w-px h-5 bg-slate-600/50 mx-0.5" />

      <button
        className={`px-1.5 h-7 rounded text-[10px] font-bold transition-colors ${
          space === "local"
            ? "bg-blue-600/40 text-blue-300"
            : "text-slate-400 hover:bg-slate-600/50"
        }`}
        onClick={toggleSpace}
        title="Toggle World/Local space (X)"
      >
        {space === "world" ? "W" : "L"}
      </button>

      <button
        className={`px-1.5 h-7 rounded text-[10px] font-bold transition-colors ${
          snap.enabled
            ? "bg-amber-600/40 text-amber-300"
            : "text-slate-400 hover:bg-slate-600/50"
        }`}
        onClick={toggleSnap}
        title="Toggle snap"
      >
        ⊞
      </button>
    </div>
  );
}
