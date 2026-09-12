"use client";

import FullmagLogo from "@/components/brand/FullmagLogo";

interface NoActiveWorkspaceStateProps {
  onOpenLauncher: () => void;
}

export function NoActiveWorkspaceState({ onOpenLauncher }: NoActiveWorkspaceStateProps) {
  return (
    <div className="relative flex h-full min-h-screen flex-col items-center justify-center overflow-hidden bg-background p-8 text-center text-sm text-muted-foreground">
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[40vw] max-h-[500px] w-[40vw] max-w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-[100px]" />

      <div className="relative z-10 flex w-full max-w-md flex-col items-center gap-6 rounded-md border border-border/60 bg-card/70 p-8 shadow-sm">
        <div className="flex h-16 w-16 items-center justify-center rounded-md border border-border/70 bg-background/70">
          <FullmagLogo size={52} className="drop-shadow-[0_0_16px_rgba(137,180,250,0.35)]" />
        </div>
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-lg font-semibold text-foreground">No active workspace</h1>
          <p className="max-w-sm leading-6 text-muted-foreground">
            Start or open a simulation from the launcher before entering the control room.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenLauncher}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
        >
          Open launcher
        </button>
      </div>
    </div>
  );
}

interface InitializingWorkspaceStateProps {
  error: string | null;
}

export function InitializingWorkspaceState({ error }: InitializingWorkspaceStateProps) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden bg-background p-8 text-sm text-muted-foreground">
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[40vw] max-h-[500px] w-[40vw] max-w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-[100px]" />

      <div className="relative z-10 flex w-full max-w-sm flex-col items-center gap-8">
        <div className="relative flex h-20 w-28 items-center justify-center">
          <div className="absolute inset-0 rounded-2xl border border-primary/20 bg-card/40 shadow-2xl backdrop-blur-xl" />
          <FullmagLogo size={96} animate className="relative z-10 drop-shadow-[0_0_20px_rgba(137,180,250,0.4)]" />
        </div>

        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex items-center gap-3">
            <span className="h-5 w-5 animate-spin rounded-full border-[3px] border-primary/20 border-t-primary" />
            <span className="text-xs font-bold uppercase tracking-[0.2em] text-primary/90">
              {error ? "Connection Error" : "Initializing Workspace"}
            </span>
          </span>
          <span className="text-xs font-medium text-muted-foreground/70">
            {error ? error : "Connecting to local Fullmag session..."}
          </span>
        </div>
      </div>
    </div>
  );
}
