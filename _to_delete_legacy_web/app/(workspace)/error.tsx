"use client";

import { useEffect } from "react";

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function WorkspaceError({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error("[workspace] Uncaught React error:", error);
  }, [error]);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="text-lg font-semibold text-red-400">Something went wrong</div>
      <div className="max-w-md text-sm text-slate-400">
        {error.message || "An unexpected error occurred in the workspace."}
        {error.digest && (
          <span className="ml-2 font-mono text-xs text-slate-500">({error.digest})</span>
        )}
      </div>
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-600"
      >
        Try again
      </button>
    </div>
  );
}
