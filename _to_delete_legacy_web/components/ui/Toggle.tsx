"use client";

import { Switch } from "./switch";
import { cn } from "@/lib/utils";

interface ToggleProps {
  label: string;
  checked: boolean;
  onchange?: (next: boolean) => void;
  className?: string;
}

export default function Toggle({ label, checked, onchange, className }: ToggleProps) {
  return (
    <label className={cn("flex items-center gap-3 cursor-pointer select-none", className)}>
      <Switch
        checked={checked}
        onCheckedChange={onchange}
      />
      <span className="text-sm font-medium text-foreground">
        {label}
      </span>
    </label>
  );
}
