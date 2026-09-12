"use client";

export function ControlRoomConnectingState() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-muted-foreground animate-pulse">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
        <span className="text-sm font-medium tracking-wide">Connecting to live workspace…</span>
      </div>
    </div>
  );
}
