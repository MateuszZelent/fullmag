"use client";

import type { ReactNode } from "react";
import FullmagLogo from "@/components/brand/FullmagLogo";

export default function StartHubShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex items-center gap-3 border-b border-border/60 pb-4">
          <FullmagLogo size={32} />
          <div className="flex flex-col">
            <span className="text-base font-semibold tracking-wide">Fullmag</span>
            <span className="text-xs text-muted-foreground">Scientific workspace launcher</span>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
