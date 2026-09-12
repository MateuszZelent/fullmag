"use client";

import { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card";
import { cn } from "@/lib/utils";

export type Tone = "default" | "accent" | "info" | "warn" | "danger" | "success";

export interface PanelProps {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  panelId?: string;
  tone?: Tone;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export default function Panel({
  title,
  subtitle,
  eyebrow,
  panelId,
  tone = "default",
  actions,
  children,
  className,
}: PanelProps) {
  return (
    <Card 
      className={cn("bg-card/40 backdrop-blur-md border border-border/50 shadow-sm", className)} 
      data-tone={tone} 
      data-panel={panelId}
    >
      <CardHeader className="flex flex-row items-start justify-between space-y-0 px-5 pt-5 pb-4">
        <div className="flex flex-col gap-1.5">
          {eyebrow && (
            <span className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground">
              {eyebrow}
            </span>
          )}
          <div className="flex flex-col gap-0.5">
            <CardTitle className="text-base font-semibold tracking-tight">{title}</CardTitle>
            {subtitle && <CardDescription className="text-xs">{subtitle}</CardDescription>}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-0">
        {children}
      </CardContent>
    </Card>
  );
}
