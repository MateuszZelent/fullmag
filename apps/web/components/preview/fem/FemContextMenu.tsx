"use client";

export function FemHoverTooltip({
  hoveredFace,
  hoveredFaceInfo,
}: {
  hoveredFace: { idx: number; x: number; y: number } | null;
  hoveredFaceInfo: { faceIdx: number; ar: number; sicn?: number | null } | null;
}) {
  if (!hoveredFace || !hoveredFaceInfo) {
    return null;
  }

  return (
    <div
      style={{ left: hoveredFace.x + 14, top: hoveredFace.y - 8 }}
      className="pointer-events-none absolute z-40 whitespace-nowrap rounded-md border border-border/30 bg-card/90 px-2.5 py-1 text-[0.68rem] font-mono text-foreground/85 shadow-md"
    >
      face #{hoveredFaceInfo.faceIdx} · AR {hoveredFaceInfo.ar.toFixed(2)}
      {hoveredFaceInfo.sicn != null ? ` · SICN ${hoveredFaceInfo.sicn.toFixed(3)}` : ""}
    </div>
  );
}

export function FemContextMenu({
  ctxMenu,
  clipEnabled,
  selectedFacesCount,
  onInspectFace,
  onShowQuality,
  onToggleClip,
  onClearSelection,
}: {
  ctxMenu: { x: number; y: number; faceIdx: number } | null;
  clipEnabled: boolean;
  selectedFacesCount: number;
  onInspectFace: (faceIdx: number) => void;
  onShowQuality: () => void;
  onToggleClip: () => void;
  onClearSelection: () => void;
}) {
  if (!ctxMenu) {
    return null;
  }

  return (
    <div
      style={{ left: ctxMenu.x, top: ctxMenu.y }}
      className="absolute z-50 min-w-[180px] rounded-lg border border-border/30 bg-gradient-to-b from-card/95 to-background/95 py-1 shadow-xl backdrop-blur-md"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        className="flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-[0.73rem] text-foreground hover:bg-muted/30"
        onClick={() => onInspectFace(ctxMenu.faceIdx)}
      >
        <span className="w-4 text-xs">🔍</span>
        Inspect face #{ctxMenu.faceIdx}
      </button>
      <button
        className="flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-[0.73rem] text-foreground hover:bg-muted/30"
        onClick={onShowQuality}
      >
        <span className="w-4 text-xs">📊</span>
        Show quality (AR)
      </button>
      <div className="mx-2.5 my-1 h-px bg-border/30" />
      <button
        className="flex w-full items-center gap-2 px-3.5 py-1.5 text-left text-[0.73rem] text-foreground hover:bg-muted/30"
        onClick={onToggleClip}
      >
        <span className="w-4 text-xs">✂️</span>
        {clipEnabled ? "Disable clip" : "Enable clip"}
      </button>
      {selectedFacesCount > 0 ? (
        <button
          className="mt-1 flex w-full items-center gap-2 border-t border-border/30 px-3.5 py-1.5 pt-1.5 text-left text-[0.73rem] text-foreground hover:bg-muted/30"
          onClick={onClearSelection}
        >
          <span className="w-4 text-center text-xs opacity-70">✕</span>
          Clear selection
        </button>
      ) : null}
    </div>
  );
}
