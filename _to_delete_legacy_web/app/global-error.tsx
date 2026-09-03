"use client";

import { useEffect } from "react";

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    console.error("[global] Uncaught React error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex h-screen w-full flex-col items-center justify-center gap-4 bg-slate-950 p-8 text-center">
        <div className="text-lg font-semibold text-red-400">Application error</div>
        <div className="max-w-md text-sm text-slate-400">
          {error.message || "A critical error occurred."}
          {error.digest && (
            <span className="ml-2 font-mono text-xs text-slate-500">({error.digest})</span>
          )}
        </div>
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-600"
        >
          Reload
        </button>
      </body>
    </html>
  );
}
