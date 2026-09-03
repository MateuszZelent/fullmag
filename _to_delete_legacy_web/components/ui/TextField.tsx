"use client";

import * as React from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

import { HelpTip } from "@/components/ui/HelpTip"

export interface TextFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  label?: string;
  unit?: string;
  mono?: boolean;
  tooltip?: React.ReactNode;
  onchange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  ({ label, unit, mono = false, tooltip, className, onchange, ...rest }, ref) => {
    return (
      <div className={cn("flex w-full min-w-0 flex-col gap-1.5", className)}>
        {label && (
          <div className="min-w-0">
            <label className="flex items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-widest text-muted-foreground">
              <span className="flex-1 truncate">{label}</span>
              {tooltip && <HelpTip>{tooltip}</HelpTip>}
            </label>
          </div>
        )}
        <div className="relative flex w-full items-center">
          <Input
            ref={ref}
            className={cn(
              "h-8 border-border/35 bg-background/60 text-xs transition-colors focus:border-primary/40",
              mono && "font-mono",
              unit && "pr-8"
            )}
            onChange={onchange}
            {...rest}
          />
          {unit && (
            <span className="absolute right-3 text-muted-foreground text-sm pointer-events-none">
              {unit}
            </span>
          )}
        </div>
      </div>
    )
  }
)
TextField.displayName = "TextField"

export default TextField;
