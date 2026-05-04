import type { LiveState, PreviewState } from "@/lib/session/types";

export default function ControlRoomPreviewNotices({
  liveState,
  previewGrid,
  previewIsInitialSampleStale,
  previewIsStale,
  previewMessage,
  spatialPreview,
}: {
  liveState: LiveState | null;
  previewGrid: [number, number, number];
  previewIsInitialSampleStale: boolean;
  previewIsStale: boolean;
  previewMessage: string | null;
  spatialPreview: Extract<PreviewState, { kind: "spatial" }> | null;
}) {
  return (
    <>
      {(spatialPreview?.auto_downscaled || liveState?.preview_auto_downscaled) && (
        <div
          className="px-2.5 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-amber-500 text-xs leading-snug"
          title={
            spatialPreview?.auto_downscale_message ??
            liveState?.preview_auto_downscale_message ??
            undefined
          }
        >
          {spatialPreview?.auto_downscale_message ??
            liveState?.preview_auto_downscale_message ??
            `Preview auto-fit to ${previewGrid[0]}×${previewGrid[1]}×${previewGrid[2]}`}
        </div>
      )}
      {(previewMessage || previewIsStale || previewIsInitialSampleStale) && (
        <div className="px-2.5 py-1.5 border-b border-border/40 bg-card/40 text-muted-foreground text-xs leading-snug">
          {previewMessage ??
            (previewIsInitialSampleStale
              ? "Showing bootstrap preview until first live preview sample arrives 2"
              : "Preview update pending")}
        </div>
      )}
    </>
  );
}
