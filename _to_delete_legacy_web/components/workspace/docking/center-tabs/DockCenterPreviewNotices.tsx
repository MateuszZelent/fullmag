"use client";

interface DockCenterPreviewNoticesProps {
  autoDownscaled: boolean;
  autoDownscaleMessage?: string | null;
  fallbackAutoDownscaleMessage?: string | null;
  previewGrid: [number, number, number];
  previewMessage?: string | null;
  previewIsStale: boolean;
  previewIsInitialSampleStale: boolean;
}

export function DockCenterPreviewNotices({
  autoDownscaled,
  autoDownscaleMessage,
  fallbackAutoDownscaleMessage,
  previewGrid,
  previewMessage,
  previewIsStale,
  previewIsInitialSampleStale,
}: DockCenterPreviewNoticesProps) {
  return (
    <>
      {autoDownscaled ? (
        <div
          className="border-b border-border/25 bg-background/40 px-2.5 py-1 text-[0.65rem] leading-tight text-muted-foreground"
          title={autoDownscaleMessage ?? fallbackAutoDownscaleMessage ?? undefined}
        >
          <span className="mr-2 text-[0.6rem] font-semibold uppercase tracking-wider opacity-70">
            Resolution Scale
          </span>
          {autoDownscaleMessage ??
            fallbackAutoDownscaleMessage ??
            `Preview auto-fit to ${previewGrid[0]}x${previewGrid[1]}x${previewGrid[2]}`}
        </div>
      ) : null}
      {previewMessage || previewIsStale || previewIsInitialSampleStale ? (
        <div className="border-b border-border/40 bg-card/40 px-2.5 py-1.5 text-xs leading-snug text-muted-foreground">
          {previewMessage ??
            (previewIsInitialSampleStale
              ? "Showing bootstrap preview until first live preview sample arrives"
              : "Preview update pending")}
        </div>
      ) : null}
    </>
  );
}
