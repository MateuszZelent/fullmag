"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";

export interface HelpTipProps {
  children?: React.ReactNode;
}

export function HelpTip({ children }: HelpTipProps) {
  if (!children) return null;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger
          type="button"
          tabIndex={-1}
          className="inline-flex items-center justify-center text-muted-foreground/60 hover:text-foreground transition-colors outline-none cursor-help"
        >
          <Info size={13} strokeWidth={2.5} />
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="start"
          sideOffset={6}
          className="max-w-[280px] text-[0.7rem] leading-relaxed shadow-xl border-border/40 font-normal tracking-wide bg-popover/95 backdrop-blur-md"
        >
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
