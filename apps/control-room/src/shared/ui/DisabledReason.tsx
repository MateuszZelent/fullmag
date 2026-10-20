"use client";

import { useId, type ReactNode } from "react";

import { cn } from "@/shared/utils/className";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./Tooltip";

interface DisabledReasonProps {
  children: ReactNode;
  className?: string;
  reason: string;
}

/**
 * Explains why a control is disabled. A disabled `<button>` receives neither
 * pointer nor focus events, so the tooltip trigger is a focusable wrapper and
 * the reason is also exposed to assistive technology via aria-describedby.
 */
export function DisabledReason({ children, className, reason }: DisabledReasonProps) {
  const descriptionId = useId();
  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-describedby={descriptionId}
            className={cn("fm-disabled-reason", className)}
            data-disabled-reason=""
            tabIndex={0}
          >
            {children}
            <span className="sr-only" id={descriptionId}>
              {reason}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
