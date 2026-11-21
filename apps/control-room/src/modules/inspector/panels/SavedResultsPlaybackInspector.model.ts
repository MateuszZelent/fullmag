export function clampPlaybackFrameIndex(frameIndex: number, frameCount: number): number {
  const lastFrame = Math.max(0, Math.floor(frameCount) - 1);
  return Math.min(lastFrame, Math.max(0, Math.floor(frameIndex)));
}

const playbackTimeFormatter = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 6 });

export function formatSavedPlaybackTimeNs(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "Unavailable";
  return `${playbackTimeFormatter.format(seconds * 1e9)} ns`;
}
