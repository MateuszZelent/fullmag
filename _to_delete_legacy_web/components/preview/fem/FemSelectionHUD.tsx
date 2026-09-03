"use client";

import { cn } from "@/lib/utils";

export function FemSelectionHUD({
  nNodes,
  nElements,
  nFaces,
  clipEnabled,
  clipAxis,
  clipPos,
  selectedFacesCount,
  compact = false,
}: {
  nNodes: number;
  nElements: number;
  nFaces: number;
  clipEnabled: boolean;
  clipAxis: "x" | "y" | "z";
  clipPos: number;
  selectedFacesCount: number;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "text-[0.65rem] text-muted-foreground font-mono pointer-events-none flex items-baseline gap-3 bg-primary-foreground/80 backdrop-blur-md px-3 py-1.5 rounded-md border border-secondary/30 shadow-md",
        compact && "gap-2 px-2.5",
      )}
    >
      <span>{nNodes.toLocaleString()} nodes</span>
      <span className="h-[3px] w-[3px] rounded-full bg-slate-500/50" />
      <span>{nElements.toLocaleString()} tets</span>
      {!compact ? (
        <>
          <span className="h-[3px] w-[3px] rounded-full bg-slate-500/50" />
          <span>{nFaces.toLocaleString()} faces</span>
        </>
      ) : null}
      {clipEnabled ? (
        <>
      <span className="h-[3px] w-[3px] rounded-full bg-secondary/50" />
          <span className="text-warning">
            clip {clipAxis.toUpperCase()} @ {clipPos}%
          </span>
        </>
      ) : null}
      {selectedFacesCount > 0 ? (
        <>
          <span className="h-[3px] w-[3px] rounded-full bg-slate-500/50" />
          <span className="text-info">{selectedFacesCount} selected</span>
        </>
      ) : null}
    </div>
  );
}

export function FemRefineToolbar({
  selectedFacesCount,
  onRefine,
  onCoarsen,
  onClear,
  className,
}: {
  selectedFacesCount: number;
  onRefine: (factor: number) => void;
  onCoarsen: (factor: number) => void;
  onClear: () => void;
  className?: string;
}) {
  if (selectedFacesCount <= 0) {
    return null;
  }

  return (
    <div className={cn("z-30 flex items-center gap-2 rounded-lg border border-secondary/30 bg-primary-foreground/90 p-2 shadow-xl backdrop-blur-md pointer-events-auto", className)}>
      <span className="px-1 font-mono text-[0.65rem] text-muted-foreground">
        {selectedFacesCount} faces
      </span>
      <div className="h-4 w-px bg-secondary/30" />
      <button
        className="rounded px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-widest text-success transition-colors hover:bg-success/10"
        onClick={() => onRefine(0.5)}
      >
        Refine ×2
      </button>
      <button
        className="rounded px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-widest text-success transition-colors hover:bg-success/10"
        onClick={() => onRefine(0.25)}
      >
        Refine ×4
      </button>
      <button
        className="rounded px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-widest text-warning transition-colors hover:bg-warning/10"
        onClick={() => onCoarsen(2)}
      >
        Coarsen ×2
      </button>
      <div className="h-4 w-px bg-slate-500/30" />
      <button
        className="rounded px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-widest text-muted-foreground transition-colors hover:bg-secondary/10 hover:text-foreground"
        onClick={onClear}
      >
        Clear
      </button>
    </div>
  );
}
