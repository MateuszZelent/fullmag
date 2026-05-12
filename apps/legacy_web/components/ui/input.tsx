import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-border/30 bg-background/60 px-3 py-1 text-sm shadow-inner shadow-black/10 transition-all outline-none",
        "selection:bg-primary/30 selection:text-primary",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground",
        "placeholder:text-muted-foreground/40",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "hover:border-border/50 hover:bg-background/80",
        "focus-visible:bg-background/90 focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/30 focus-visible:shadow-[0_0_0_1px_rgba(137,180,250,0.1)]",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
