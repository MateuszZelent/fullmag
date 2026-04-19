"use client";

/**
 * P3 — Geometry Builder Universe Inspector
 *
 * Inspector panel for the Universe node in geometry builder.
 * Shows universe bounds, origin, constraint policy, and visibility.
 */

import { Box, Eye, EyeOff, Shield } from "lucide-react";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";
import type { Vec3, UniverseConstraintPolicy } from "../model/types";

function formatSI(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(3)} mm`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(3)} μm`;
  return `${(value * 1e9).toFixed(3)} nm`;
}

function NumberField({
  label,
  value,
  onChange,
  min,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-20 text-xs text-muted-foreground shrink-0">{label}</label>
      <input
        type="number"
        className="flex-1 bg-muted/50 border border-border rounded px-2 py-1 text-xs font-mono text-foreground"
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (!Number.isNaN(v) && (min === undefined || v >= min)) {
            onChange(v);
          }
        }}
        min={min}
        step={1e-9}
      />
      <span className="text-[10px] text-muted-foreground w-6">m</span>
    </div>
  );
}

function Vec3Field({
  label,
  value,
  onChange,
  labels = ["X", "Y", "Z"],
  min,
}: {
  label: string;
  value: Vec3;
  onChange: (v: Vec3) => void;
  labels?: [string, string, string];
  min?: number;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      {labels.map((axisLabel, i) => (
        <NumberField
          key={axisLabel}
          label={axisLabel}
          value={value[i]}
          onChange={(v) => {
            const next: Vec3 = [...value];
            next[i] = v;
            onChange(next);
          }}
          min={min}
        />
      ))}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 border-b border-border pb-1">
        {title}
      </h3>
      <div className="space-y-2 pl-1">{children}</div>
    </div>
  );
}

const POLICY_LABELS: Record<UniverseConstraintPolicy, string> = {
  block_commit: "Block commit",
  clamp_on_release: "Clamp on release",
  preview_only_block_commit: "Preview + block commit",
};

export default function BuilderUniverseInspector() {
  const universe = useGeometryBuilderStore((s) => s.graph.universe);
  const constraintPolicy = useGeometryBuilderStore((s) => s.constraintPolicy);
  const setUniverseSize = useGeometryBuilderStore((s) => s.setUniverseSize);
  const setUniverseOrigin = useGeometryBuilderStore((s) => s.setUniverseOrigin);
  const setUniverseVisibility = useGeometryBuilderStore((s) => s.setUniverseVisibility);

  return (
    <div className="flex flex-col gap-4 p-3 text-sm">
      {/* ── Identity ─────────────────────────────────────────── */}
      <Section title="Universe">
        <div className="flex items-center gap-2">
          <Box size={16} className="text-cyan-400" />
          <span className="text-xs">Bounding box workspace</span>
        </div>
      </Section>

      {/* ── Bounds ───────────────────────────────────────────── */}
      <Section title="Bounds">
        <Vec3Field
          label="Size"
          value={universe.size}
          onChange={setUniverseSize}
          labels={["Width", "Depth", "Height"]}
          min={1e-9}
        />
        <div className="text-[10px] text-muted-foreground">
          {formatSI(universe.size[0])} × {formatSI(universe.size[1])} × {formatSI(universe.size[2])}
        </div>
      </Section>

      {/* ── Origin ───────────────────────────────────────────── */}
      <Section title="Origin">
        <Vec3Field
          label="Center"
          value={universe.origin}
          onChange={setUniverseOrigin}
        />
      </Section>

      {/* ── Visualization ────────────────────────────────────── */}
      <Section title="Display">
        <button
          type="button"
          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
            universe.visibility
              ? "bg-primary/10 text-primary"
              : "bg-muted/50 text-muted-foreground hover:bg-muted"
          }`}
          onClick={() => setUniverseVisibility(!universe.visibility)}
        >
          {universe.visibility ? <Eye size={12} /> : <EyeOff size={12} />}
          {universe.visibility ? "Visible" : "Hidden"}
        </button>
      </Section>

      {/* ── Constraint policy ────────────────────────────────── */}
      <Section title="Constraint Policy">
        <div className="flex items-center gap-2">
          <Shield size={14} className="text-amber-400" />
          <span className="text-xs">{POLICY_LABELS[constraintPolicy]}</span>
        </div>
        <div className="text-[10px] text-muted-foreground">
          Objects that exceed Universe bounds will be previewed with a warning.
          Commit is blocked until placement is valid.
        </div>
      </Section>
    </div>
  );
}
