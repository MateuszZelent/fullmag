import * as React from "react"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

export interface SegmentedOption {
  value: string
  label: React.ReactNode
  title?: string
}

/** Pill segmented control with a sliding thumb (Radix single toggle group underneath). */
function Segmented({
  value,
  onValueChange,
  options,
  className,
  size = "default",
  invalid,
  ...props
}: {
  value: string
  onValueChange: (v: string) => void
  options: SegmentedOption[]
  className?: string
  size?: "default" | "sm"
  invalid?: boolean
} & Omit<React.ComponentProps<"div">, "onChange" | "defaultValue" | "dir">) {
  const i = Math.max(0, options.findIndex((o) => o.value === value))
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v)}
      data-slot="segmented"
      aria-invalid={invalid || undefined}
      className={cn(
        "relative grid w-full min-w-0 auto-cols-fr grid-flow-col rounded-full bg-field p-[3px] ring-1 ring-border ring-inset",
        size === "sm" ? "h-7" : "h-8",
        invalid && "ring-destructive/70",
        className
      )}
      style={{ "--n": options.length, "--i": i } as React.CSSProperties}
      {...props}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-[3px] left-[3px] w-[calc((100%-6px)/var(--n))] translate-x-[calc(var(--i)*100%)] rounded-full bg-raised shadow-[0px_2px_3px_-1px_rgba(0,0,0,0.1),0px_1px_0px_0px_rgba(25,28,33,0.02),0px_0px_0px_1px_rgba(25,28,33,0.08)] transition-transform duration-300 ease-out-soft dark:shadow-none dark:ring-1 dark:ring-white/10 dark:ring-inset"
      />
      {options.map((o) => (
        <ToggleGroupPrimitive.Item
          key={o.value}
          value={o.value}
          title={o.title}
          className="relative z-10 flex min-w-0 items-center justify-center gap-1.5 truncate rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=on]:text-foreground [&_svg]:size-3.5"
        >
          {o.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}

export { Segmented }
