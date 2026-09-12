"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import Sparkline from "../../ui/Sparkline";
import type { ScalarRow } from "@/lib/session/types";

const SPARK_HISTORY_LIMIT = 40;

export function buildSparkSeries(
  rows: ScalarRow[],
  select: (row: ScalarRow) => number,
  currentValue?: number | null,
  transform: (value: number) => number = (value) => value,
): number[] {
  const samples = rows
    .slice(-SPARK_HISTORY_LIMIT)
    .map((row) => transform(select(row)))
    .filter((value) => Number.isFinite(value));

  if (currentValue == null || !Number.isFinite(currentValue)) return samples;
  const currentSample = transform(currentValue);
  if (!Number.isFinite(currentSample)) return samples;
  if (samples.length === 0) return [currentSample, currentSample];

  const last = samples[samples.length - 1];
  if (last !== currentSample) {
    return [...samples.slice(-(SPARK_HISTORY_LIMIT - 1)), currentSample];
  }
  return samples;
}

import { HelpTip } from "../../ui/HelpTip";

interface MetricFieldProps {
  label: string;
  value: string;
  sparkData?: number[];
  sparkColor?: string;
  tooltip?: React.ReactNode;
  valueTone?: "success";
}

export function MetricField({ label, value, sparkData, sparkColor, tooltip, valueTone }: MetricFieldProps) {
  return (
    <div className="flex flex-col gap-1.5 py-2 border-b border-border/10">
      <span className="flex items-center gap-2 text-[0.6rem] font-bold uppercase tracking-widest text-muted-foreground/70">
        <span className="flex-1">{label}</span>
        {tooltip && <HelpTip>{tooltip}</HelpTip>}
      </span>
      <span className={cn(
        "font-mono text-sm text-foreground tracking-tight font-medium",
        valueTone === "success" ? "text-success" : undefined
      )}>
        {value}
      </span>
      {sparkData && sparkColor && (
        <div className="h-6 w-full mt-1 opacity-90" style={{position: "relative"}}>
          <Sparkline
            data={sparkData}
            height={20}
            color={sparkColor}
            fill={false}
            responsive
          />
        </div>
      )}
    </div>
  );
}

interface SidebarSectionProps {
  title: string;
  icon?: string;
  badge?: string | null;
  defaultOpen?: boolean;
  autoOpenKey?: string | null;
  children: ReactNode;
}

export function SidebarSection({
  title,
  icon,
  badge,
  defaultOpen = true,
  autoOpenKey,
  children,
}: SidebarSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const resolvedOpen = Boolean(autoOpenKey) || open;

  return (
    <section className="flex flex-col mb-2 border-b border-border/20 pb-3 last:border-b-0">
      <button
        type="button"
        className="flex items-center w-full py-2.5 text-left transition-opacity hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring group"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={resolvedOpen}
      >
        <span className={cn(
          "text-muted-foreground/50 transition-transform duration-200 mr-2 flex items-center justify-center w-4 h-4 text-[10px]",
          resolvedOpen ? "rotate-90" : ""
        )}>▸</span>
        {icon && (
          <span className="mr-2 text-[0.8rem] text-primary/70">{icon}</span>
        )}
        <span className="text-[0.72rem] font-bold uppercase tracking-wider text-foreground/80 group-hover:text-foreground transition-colors flex-1">
          {title}
        </span>
        {badge ? (
          <span className="ml-3 text-[0.6rem] font-mono tracking-tight text-primary/80 bg-primary/10 px-1.5 py-0.5 rounded border border-primary/20">
            {badge}
          </span>
        ) : null}
      </button>
      {resolvedOpen ? (
        <div className="@container pl-2 pr-1 flex flex-col gap-2.5 animate-in fade-in slide-in-from-top-1 duration-200 pb-1">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/* ── Sub-section header for use inside panels ── */

interface SubSectionHeaderProps {
  title: string;
  icon?: string;
}

export function SubSectionHeader({ title, icon }: SubSectionHeaderProps) {
  return (
    <h4 className="flex items-center gap-2 text-[0.65rem] font-bold uppercase tracking-widest text-foreground/70 pb-1 mt-2 mb-1">
      {icon ? (
        <span className="text-xs opacity-70">{icon}</span>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-primary/40 inline-block" />
      )}
      {title}
    </h4>
  );
}

/* ── Info row for key-value pairs in inspector panels ── */

interface InfoRowProps {
  label: string;
  value: string;
  mono?: boolean;
}

export function InfoRow({ label, value, mono = true }: InfoRowProps) {
  return (
    <div className="flex items-center justify-between py-1 gap-3 group">
      <span className="text-[0.68rem] font-medium text-muted-foreground group-hover:text-foreground transition-colors">
        {label}
      </span>
      <span className={cn(
        "text-[0.72rem] text-foreground truncate text-right",
        mono && "font-mono tracking-tight"
      )}>
        {value}
      </span>
    </div>
  );
}

/* ── Property row — label left, value in dark inset-styled box ── */

interface PropertyRowProps {
  label: string;
  value: string;
  icon?: ReactNode;
  mono?: boolean;
}

export function PropertyRow({ label, value, icon, mono = false }: PropertyRowProps) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 group">
      <span className="text-[0.68rem] font-medium text-muted-foreground group-hover:text-foreground transition-colors shrink-0">
        {label}
      </span>
      <div className={cn(
        "flex items-center justify-end gap-1.5 text-[0.72rem] text-foreground min-w-0 text-right",
        mono && "font-mono tracking-tight"
      )}>
        {icon && <span className="shrink-0 text-muted-foreground/60">{icon}</span>}
        <span className="truncate">{value}</span>
      </div>
    </div>
  );
}

/* ── Status badge — colored pill for "Running", "Medium", "Tet4" etc. ── */

type BadgeTone = "default" | "success" | "info" | "warn" | "accent";

interface StatusBadgeProps {
  label: string;
  tone?: BadgeTone;
  dot?: boolean;
}

const badgeToneClasses: Record<BadgeTone, string> = {
  default: "text-muted-foreground bg-muted/40",
  success: "text-success bg-success/15",
  info: "text-info bg-info/15",
  warn: "text-warning bg-warning/15",
  accent: "text-primary bg-primary/15",
};

export function StatusBadge({ label, tone = "default", dot }: StatusBadgeProps) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-widest whitespace-nowrap",
      badgeToneClasses[tone]
    )}>
      {dot && (
        <span className={cn(
          "h-1.5 w-1.5 rounded-full shrink-0",
          tone === "success" ? "bg-success" :
          tone === "info" ? "bg-info" :
          tone === "warn" ? "bg-warning" :
          tone === "accent" ? "bg-primary" :
          "bg-muted-foreground/50"
        )} />
      )}
      {label}
    </span>
  );
}

/* ── Toggle row — label + toggle switch ── */

interface ToggleRowProps {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

export function ToggleRow({ label, checked, onChange, disabled }: ToggleRowProps) {
  return (
    <label className={cn(
      "flex flex-wrap items-center justify-between gap-3 py-1 cursor-pointer select-none group",
      disabled && "opacity-50 cursor-not-allowed"
    )}>
      <span className="text-[0.68rem] font-medium text-muted-foreground group-hover:text-foreground transition-colors flex-1 min-w-[120px]">
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cn(
          "relative inline-flex h-[18px] w-[32px] shrink-0 rounded-full border transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          checked
            ? "border-primary/40 bg-primary/80"
            : "border-border/50 bg-muted/50"
        )}
      >
        <span
          className={cn(
            "pointer-events-none block h-3 w-3 rounded-full bg-background shadow-sm transform transition-transform duration-200 translate-y-[1px]",
            checked ? "translate-x-[15px]" : "translate-x-[2px]"
          )}
        />
      </button>
    </label>
  );
}

/* ── Compact input grid — labeled 3-col input group (X / Y / Z, R_x / R_y / R_z, etc.) ── */

interface CompactInputGridProps {
  label: string;
  fields: Array<{
    label: string;
    value: string;
    onChange?: (val: string) => void;
    disabled?: boolean;
  }>;
}

export function CompactInputGrid({ label, fields }: CompactInputGridProps) {
  return (
    <div className="flex flex-col @[260px]:flex-row @[260px]:items-center justify-between gap-1.5 @[260px]:gap-3 py-1.5 w-full group">
      <span className="text-[0.68rem] font-medium text-muted-foreground group-hover:text-foreground transition-colors shrink-0 min-w-0 @[260px]:w-[70px]">
        {label}
      </span>
      <div className="flex-1 w-full flex items-center justify-end gap-1.5 min-w-0">
        {fields.map((field) => (
          <div key={field.label} className="flex flex-1 items-center gap-1.5 bg-card/40 border border-border/10 rounded-md px-1.5 py-0.5 focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/20 transition-all hover:border-border/60">
            <span className="text-[0.55rem] font-bold text-muted-foreground/60 select-none">
              {field.label}
            </span>
            <input
              className={cn(
                "h-6 w-full min-w-[20px] bg-transparent text-xs font-mono text-foreground outline-none text-right placeholder:text-muted-foreground/30",
                field.disabled && "opacity-50 cursor-not-allowed"
              )}
              defaultValue={field.value}
              disabled={field.disabled}
              onBlur={(e) => field.onChange?.(e.target.value)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Inspector Layout Primitives (Comsol-inspired) ── */

export function InspectorSection({
  title,
  eyebrow,
  meta,
  defaultOpen,
  children,
}: {
  title: string;
  eyebrow?: string;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  void defaultOpen;
  return (
    <section className="flex flex-col mt-3 mb-2">
      <div className="mb-2.5 flex items-end justify-between gap-3 border-b border-border/10 pb-1.5">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-[0.55rem] font-bold tracking-widest uppercase text-muted-foreground/60 mb-0.5">
              {eyebrow}
            </p>
          ) : null}
          <h3 className="text-[0.75rem] font-semibold text-foreground/90">{title}</h3>
        </div>
        {meta ? <div className="shrink-0">{meta}</div> : null}
      </div>
      <div className="@container flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

export function InspectorField({
  label,
  hint,
  control,
  layout = "default",
}: {
  label: string;
  hint?: ReactNode;
  control: ReactNode;
  layout?: "default" | "stack";
}) {
  return (
    <div className={cn(
      "flex gap-3 py-1 group",
      layout === "default" ? "flex-col @[280px]:flex-row @[280px]:items-center justify-between" : "flex-col"
    )}>
      <div className={cn("min-w-0 flex-1", layout === "default" ? "@[280px]:mb-0" : "")}>
        <div className="text-[0.68rem] font-medium text-muted-foreground group-hover:text-foreground transition-colors">{label}</div>
        {hint ? <div className="mt-0.5 text-[0.6rem] text-muted-foreground/60 leading-relaxed">{hint}</div> : null}
      </div>
      <div className={cn("min-w-0 shrink-0", layout === "default" ? "w-full @[280px]:w-[160px]" : "w-full")}>
        {control}
      </div>
    </div>
  );
}

export function InspectorDataGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 py-1">
      {children}
    </div>
  );
}

export function InspectorStatTile({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="flex flex-col border-l-2 border-primary/20 pl-2.5 py-0.5 my-0.5 hover:border-primary/50 transition-colors">
      <div className="text-[0.55rem] font-bold tracking-widest uppercase text-muted-foreground/60">
        {label}
      </div>
      <div className="font-mono text-[0.72rem] font-medium text-foreground tracking-tight mt-0.5">{value}</div>
    </div>
  );
}
