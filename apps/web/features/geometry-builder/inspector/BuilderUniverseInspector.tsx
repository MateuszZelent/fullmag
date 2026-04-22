"use client";

/**
 * P3 — Geometry Builder Universe Inspector
 *
 * Inspector panel for the Universe node in geometry builder.
 * Shows: universe bounds, origin, constraint policy, diagnostics (crossing
 * / outside objects), and action buttons (Fit, Center, Reset).
 */

import { Box, Eye, EyeOff, Maximize2, AlignCenter, RotateCcw, AlertTriangle, CheckCircle } from "lucide-react";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";
import type { Vec3, UniverseConstraintPolicy } from "../model/types";

// ── Helpers ───────────────────────────────────────────────────

function formatSI(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(3)} mm`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(3)} μm`;
  return `${(value * 1e9).toFixed(3)} nm`;
}

// ── Sub-components ────────────────────────────────────────────

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
      {(labels as string[]).map((axisLabel, i) => (
        <NumberField
          key={axisLabel}
          label={axisLabel}
          value={value[i]}
          onChange={(v) => {
            const next: Vec3 = [...value] as Vec3;
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

// ── Policy configuration ──────────────────────────────────────

const POLICY_OPTIONS: Array<{
  value: UniverseConstraintPolicy;
  label: string;
  description: string;
}> = [
  {
    value: "preview_only_block_build",
    label: "Preview + Block Build",
    description: "Show warning; block Build Geometry when objects exceed bounds.",
  },
  {
    value: "block_build",
    label: "Block Build",
    description: "Strictly block Build Geometry for any out-of-bounds object.",
  },
  {
    value: "auto_fit_universe",
    label: "Auto-fit Universe",
    description: "Automatically expand the Universe to fit all objects before build.",
  },
  {
    value: "clip_with_explicit_ack",
    label: "Clip with Acknowledgment",
    description: "Clip objects at Universe boundary; requires explicit confirmation.",
  },
];

// ── Main component ────────────────────────────────────────────

export default function BuilderUniverseInspector() {
  const universe = useGeometryBuilderStore((s) => s.graph.universe);
  const constraintPolicy = useGeometryBuilderStore((s) => s.constraintPolicy);
  const setUniverseSize = useGeometryBuilderStore((s) => s.setUniverseSize);
  const setUniverseOrigin = useGeometryBuilderStore((s) => s.setUniverseOrigin);
  const setUniverseVisibility = useGeometryBuilderStore((s) => s.setUniverseVisibility);
  const setUniversePolicy = useGeometryBuilderStore((s) => s.setUniversePolicy);
  const clipAcknowledged = useGeometryBuilderStore((s) => s.clipAcknowledged);
  const setClipAcknowledged = useGeometryBuilderStore((s) => s.setClipAcknowledged);
  const fitUniverseToObjects = useGeometryBuilderStore((s) => s.fitUniverseToObjects);
  const resetUniverseToDefault = useGeometryBuilderStore((s) => s.resetUniverseToDefault);
  const validateAll = useGeometryBuilderStore((s) => s.validateAll);
  const getAllPrimitives = useGeometryBuilderStore((s) => s.getAllPrimitives);
  const setUniverseOriginToCenter = () => {
    // Center origin on enabled primitives bounding box
    const prims = getAllPrimitives().filter((p) => p.enabled);
    if (prims.length === 0) {
      setUniverseOrigin([0, 0, 0]);
      return;
    }
    // Compute centroid of translations
    const sum = prims.reduce(
      (acc, p) => [acc[0] + p.transform.translation[0], acc[1] + p.transform.translation[1], acc[2] + p.transform.translation[2]] as Vec3,
      [0, 0, 0] as Vec3,
    );
    setUniverseOrigin([sum[0] / prims.length, sum[1] / prims.length, sum[2] / prims.length]);
  };

  // Diagnostics
  const validations = validateAll();
  const crossingCount = validations.filter((v) => v.intersectsUniverseBoundary && !v.exceedsUniverse).length;
  const outsideCount = validations.filter((v) => v.exceedsUniverse).length;
  const hasBoundaryIssues = crossingCount > 0 || outsideCount > 0;

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

      {/* ── Diagnostics ──────────────────────────────────────── */}
      <Section title="Diagnostics">
        {!hasBoundaryIssues ? (
          <div className="flex items-center gap-1.5 text-[10px] text-emerald-400">
            <CheckCircle size={12} />
            <span>All objects within Universe bounds.</span>
          </div>
        ) : (
          <div className="space-y-1">
            {outsideCount > 0 && (
              <div className="flex items-start gap-1.5 text-[10px] text-red-400">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                <span>
                  {outsideCount} object{outsideCount !== 1 ? "s" : ""} exceed Universe bounds. Fit Universe, move objects, or explicitly clip.
                </span>
              </div>
            )}
            {crossingCount > 0 && (
              <div className="flex items-start gap-1.5 text-[10px] text-amber-400">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                <span>
                  {crossingCount} object{crossingCount !== 1 ? "s" : ""} cross the Universe boundary.
                </span>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* ── Actions ──────────────────────────────────────────── */}
      <Section title="Actions">
        <div className="space-y-1.5">
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs text-foreground bg-muted/50 hover:bg-muted border border-border/50 hover:border-border transition-colors disabled:opacity-40 disabled:pointer-events-none"
            onClick={() => fitUniverseToObjects()}
            title="Expand Universe to fit all enabled objects with 10% padding"
          >
            <Maximize2 size={12} className="text-amber-400" />
            Fit to Objects
          </button>

          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs text-foreground bg-muted/50 hover:bg-muted border border-border/50 hover:border-border transition-colors"
            onClick={setUniverseOriginToCenter}
            title="Centre the Universe origin on the mean position of all enabled objects"
          >
            <AlignCenter size={12} className="text-sky-400" />
            Center on Objects
          </button>

          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs text-foreground bg-muted/50 hover:bg-muted border border-border/50 hover:border-border transition-colors"
            onClick={resetUniverseToDefault}
            title="Reset Universe to default 1 µm³ cube centred at origin"
          >
            <RotateCcw size={12} className="text-muted-foreground" />
            Reset to Default
          </button>
        </div>
      </Section>

      {/* ── Constraint policy ────────────────────────────────── */}
      <Section title="Constraint Policy">
        <div className="space-y-1">
          {POLICY_OPTIONS.map(({ value, label, description }) => (
            <label
              key={value}
              className="flex items-start gap-2 rounded-md p-2 cursor-pointer hover:bg-muted/40 transition-colors"
            >
              <input
                type="radio"
                name="universe-policy"
                value={value}
                checked={constraintPolicy === value}
                onChange={() => setUniversePolicy(value)}
                className="mt-0.5 accent-primary shrink-0"
              />
              <div>
                <div className="text-xs font-medium text-foreground">{label}</div>
                <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">{description}</div>
              </div>
            </label>
          ))}
        </div>
        {constraintPolicy === "clip_with_explicit_ack" && hasBoundaryIssues ? (
          <div className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/10 p-2">
            <div className="flex items-start gap-1.5 text-[10px] text-amber-400">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                Clipping changes solver geometry. Confirm clipping before Build Geometry.
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className={`rounded px-2.5 py-1 text-[10px] font-medium transition-colors ${
                  clipAcknowledged
                    ? "border border-emerald-500/40 bg-emerald-500/20 text-emerald-300"
                    : "border border-amber-500/40 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30"
                }`}
                onClick={() => setClipAcknowledged(!clipAcknowledged)}
              >
                {clipAcknowledged ? "Clipping acknowledged" : "Acknowledge clipping"}
              </button>
              {clipAcknowledged ? (
                <span className="text-[10px] text-emerald-300/80">Build Geometry unlocked for clip policy.</span>
              ) : null}
            </div>
          </div>
        ) : null}
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
    </div>
  );
}
