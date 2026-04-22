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
    <div className="flex flex-col gap-1.5 p-3 bg-gradient-to-b from-card/40 to-card/15 border border-border/30 rounded-lg backdrop-blur-sm transition-colors hover:border-border/50">
      <span className="flex items-center gap-2 text-[0.6rem] font-semibold uppercase tracking-wider text-muted-foreground/80">
        <span className="flex-1">{label}</span>
        {tooltip && <HelpTip>{tooltip}</HelpTip>}
      </span>
      <span className={cn(
        "font-mono text-xs text-foreground tracking-tight",
        valueTone === "success" ? "text-success" : undefined
      )}>
        {value}
      </span>
      {sparkData && sparkColor && (
        <div className="h-6 w-full mt-0.5 opacity-80" style={{position: "relative"}}>
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
    <section className="flex flex-col mb-3 overflow-hidden rounded-xl border border-border/40 bg-gradient-to-b from-card/50 to-card/20 shadow-[0_2px_12px_rgba(0,0,0,0.15)] backdrop-blur-xl">
      <button
        type="button"
        className="flex items-center w-full px-4 py-3 text-left transition-all hover:bg-muted/15 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring group"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={resolvedOpen}
      >
        <span className={cn(
          "text-primary/70 transition-transform duration-200 mr-2.5 flex items-center justify-center w-4 h-4 text-[11px]",
          resolvedOpen && "rotate-90"
        )}>▸</span>
        {icon && (
          <span className="mr-2 text-sm opacity-70">{icon}</span>
        )}
        <span className="text-[0.75rem] font-semibold tracking-wide text-foreground/90 group-hover:text-foreground transition-colors">
          {title}
        </span>
        {badge ? (
          <span className="ml-auto text-[0.6rem] font-mono tracking-tight text-primary/80 bg-primary/8 px-2 py-0.5 rounded-md border border-primary/15">
            {badge}
          </span>
        ) : null}
      </button>
      {resolvedOpen ? (
        <div className="@container px-4 pb-4 pt-2 flex flex-col gap-4 border-t border-border/20">
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
    <h4 className="flex items-center gap-2 text-[0.65rem] font-bold uppercase tracking-widest text-primary/80 pb-2 mb-1 border-b border-border/30">
      {icon ? (
        <span className="text-xs opacity-70">{icon}</span>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-primary/60 inline-block" />
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
    <div className="flex items-center justify-between py-1.5 gap-3">
      <span className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground/80">
        {label}
      </span>
      <span className={cn(
        "text-xs text-muted-foreground truncate text-right",
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
    <div className="flex items-center gap-3 py-1">
      <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80 shrink-0 min-w-[4.5rem]">
        {label}
      </span>
      <div className={cn(
        "flex-1 flex items-center gap-2 h-8 px-3 rounded-md border border-border/30 bg-background/60 shadow-inner shadow-black/10 text-xs text-foreground min-w-0",
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
  default: "border-border/40 bg-muted/30 text-muted-foreground",
  success: "border-success/30 bg-success/10 text-success",
  info: "border-info/30 bg-info/10 text-info",
  warn: "border-warning/30 bg-warning/10 text-warning",
  accent: "border-primary/30 bg-primary/10 text-primary",
};

export function StatusBadge({ label, tone = "default", dot }: StatusBadgeProps) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[0.6rem] font-bold uppercase tracking-widest whitespace-nowrap",
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
      "flex flex-wrap items-center justify-between gap-3 py-1.5 cursor-pointer select-none group",
      disabled && "opacity-50 cursor-not-allowed"
    )}>
      <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80 group-hover:text-foreground transition-colors flex-1 min-w-[120px]">
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 rounded-full border transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          checked
            ? "border-primary/40 bg-primary/60"
            : "border-border/50 bg-muted/30"
        )}
      >
        <span
          className={cn(
            "pointer-events-none block h-4 w-4 rounded-full bg-foreground shadow-sm transform transition-transform duration-200",
            checked ? "translate-x-4" : "translate-x-0"
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
    <div className="flex flex-col @[260px]:flex-row @[260px]:items-start gap-1.5 @[260px]:gap-3 py-1 w-full">
      <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/80 shrink-0 min-w-0 @[260px]:min-w-[4.5rem] @[260px]:pt-2 flex-1">
        {label}
      </span>
      <div className="flex-1 w-full grid gap-1.5 min-w-0" style={{ gridTemplateColumns: `repeat(${fields.length}, 1fr)` }}>
        {fields.map((field) => (
          <div key={field.label} className="flex flex-col gap-0.5">
            <span className="text-[0.5rem] font-semibold uppercase tracking-widest text-muted-foreground/60 pl-0.5">
              {field.label}
            </span>
            <input
              className={cn(
                "h-7 w-full rounded-md border border-border/30 bg-background/60 px-2 text-xs font-mono text-foreground shadow-inner shadow-black/10 outline-none transition-all",
                "hover:border-border/50 focus:border-primary/40 focus:ring-1 focus:ring-primary/30",
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
    <section className="rounded-2xl border border-border/30 bg-background/35 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.02)]">
      <div className="mb-3 flex items-start justify-between gap-3 border-b border-border/20 pb-2.5">
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-[0.62rem] font-semibold tracking-[0.12em] text-muted-foreground">
              {eyebrow}
            </p>
          ) : null}
          <h3 className="text-[0.86rem] font-semibold text-foreground">{title}</h3>
        </div>
        {meta ? <div className="shrink-0">{meta}</div> : null}
      </div>
      <div className="@container flex flex-col gap-3">{children}</div>
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
      "flex gap-3",
      layout === "default" ? "flex-col @[280px]:flex-row @[280px]:items-center" : "flex-col"
    )}>
      <div className={cn("min-w-0 flex-1", layout === "default" ? "@[280px]:mb-0" : "")}>
        <div className="text-[0.73rem] font-medium text-foreground">{label}</div>
        {hint ? <div className="mt-0.5 text-[0.64rem] text-muted-foreground leading-relaxed">{hint}</div> : null}
      </div>
      <div className={cn("min-w-0 shrink-0", layout === "default" ? "w-full @[280px]:w-[140px]" : "w-full")}>
        {control}
      </div>
    </div>
  );
}

export function InspectorDataGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-2">
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
    <div className="rounded-xl border border-border/18 bg-background/25 px-3 py-2">
      <div className="text-[0.62rem] font-semibold tracking-[0.08em] uppercase text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-mono text-[0.76rem] text-foreground">{value}</div>
    </div>
  );
}
