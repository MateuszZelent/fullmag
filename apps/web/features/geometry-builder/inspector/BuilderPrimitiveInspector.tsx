"use client";

/**
 * P3 — Geometry Builder Inspector Panel
 *
 * Inspector panel for geometry builder primitives.
 * Shows: Identity, Parameters, Transform, Placement Diagnostics, Lifecycle.
 */

import { useCallback, useMemo } from "react";
import {
  Box,
  Circle,
  Cylinder,
  Disc,
  Triangle,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Power,
  PowerOff,
  Copy,
  Trash2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Maximize2,
  ArrowRight,
} from "lucide-react";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";
import { PRIMITIVE_CAPABILITIES } from "../model/types";
import type { PrimitiveNode, PrimitiveKind, Transform3D, Vec3 } from "../model/types";

// ── Helpers ───────────────────────────────────────────────────

function formatSI(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e-3) return `${(value * 1e3).toFixed(3)} mm`;
  if (abs >= 1e-6) return `${(value * 1e6).toFixed(3)} μm`;
  return `${(value * 1e9).toFixed(3)} nm`;
}

const PRIMITIVE_LABELS: Record<PrimitiveKind, string> = {
  box: "Box",
  cylinder: "Cylinder",
  sphere: "Sphere",
  disk: "Disk",
  triangular_prism: "Triangular Prism",
};

const PRIMITIVE_ICONS: Record<PrimitiveKind, React.ReactNode> = {
  box: <Box size={16} />,
  cylinder: <Cylinder size={16} />,
  sphere: <Circle size={16} />,
  disk: <Disc size={16} />,
  triangular_prism: <Triangle size={16} />,
};

// ── Number input ──────────────────────────────────────────────

function NumberField({
  label,
  value,
  onChange,
  unit = "m",
  min,
  step,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  min?: number;
  step?: number;
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
        step={step ?? 1e-9}
      />
      <span className="text-[10px] text-muted-foreground w-6">{unit}</span>
    </div>
  );
}

// ── Vec3 input ────────────────────────────────────────────────

function Vec3Field({
  label,
  value,
  onChange,
  labels = ["X", "Y", "Z"],
}: {
  label: string;
  value: Vec3;
  onChange: (v: Vec3) => void;
  labels?: [string, string, string];
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
        />
      ))}
    </div>
  );
}

// ── Axis selector ─────────────────────────────────────────────

function AxisField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: "x" | "y" | "z";
  onChange: (v: "x" | "y" | "z") => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-20 text-xs text-muted-foreground shrink-0">{label}</label>
      <div className="flex gap-1">
        {(["x", "y", "z"] as const).map((axis) => (
          <button
            key={axis}
            type="button"
            className={`px-2 py-0.5 rounded text-xs font-mono ${
              value === axis
                ? "bg-primary text-primary-foreground"
                : "bg-muted/50 text-muted-foreground hover:bg-muted"
            }`}
            onClick={() => onChange(axis)}
          >
            {axis.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Toggle button ─────────────────────────────────────────────

function ToggleButton({
  active,
  onClick,
  iconOn,
  iconOff,
  label,
}: {
  active: boolean;
  onClick: () => void;
  iconOn: React.ReactNode;
  iconOff: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs ${
        active
          ? "bg-primary/10 text-primary"
          : "bg-muted/50 text-muted-foreground hover:bg-muted"
      }`}
      onClick={onClick}
      title={label}
    >
      {active ? iconOn : iconOff}
      <span>{label}</span>
    </button>
  );
}

// ── Section wrapper ───────────────────────────────────────────

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

// ── Params section ────────────────────────────────────────────

function ParamsSection({ node }: { node: PrimitiveNode }) {
  const setPrimitiveParams = useGeometryBuilderStore((s) => s.setPrimitiveParams);

  switch (node.params.kind) {
    case "box":
      return (
        <Section title="Parameters">
          <Vec3Field
            label="Size"
            value={node.params.data.size}
            onChange={(size) => setPrimitiveParams(node.id, { kind: "box", data: { size } })}
            labels={["Width", "Depth", "Height"]}
          />
        </Section>
      );
    case "cylinder":
      return (
        <Section title="Parameters">
          <NumberField
            label="Radius"
            value={node.params.data.radius}
            onChange={(radius) =>
              setPrimitiveParams(node.id, { kind: "cylinder", data: { ...node.params.data as any, radius } })
            }
            min={0}
          />
          <NumberField
            label="Height"
            value={node.params.data.height}
            onChange={(height) =>
              setPrimitiveParams(node.id, { kind: "cylinder", data: { ...node.params.data as any, height } })
            }
            min={0}
          />
          <AxisField
            label="Axis"
            value={(node.params.data as any).axis}
            onChange={(axis) =>
              setPrimitiveParams(node.id, { kind: "cylinder", data: { ...node.params.data as any, axis } })
            }
          />
        </Section>
      );
    case "sphere":
      return (
        <Section title="Parameters">
          <NumberField
            label="Radius"
            value={node.params.data.radius}
            onChange={(radius) => setPrimitiveParams(node.id, { kind: "sphere", data: { radius } })}
            min={0}
          />
        </Section>
      );
    case "disk":
      return (
        <Section title="Parameters">
          <NumberField
            label="Radius"
            value={node.params.data.radius}
            onChange={(radius) =>
              setPrimitiveParams(node.id, { kind: "disk", data: { ...node.params.data as any, radius } })
            }
            min={0}
          />
          <NumberField
            label="Thickness"
            value={node.params.data.thickness}
            onChange={(thickness) =>
              setPrimitiveParams(node.id, { kind: "disk", data: { ...node.params.data as any, thickness } })
            }
            min={0}
          />
          <AxisField
            label="Axis"
            value={(node.params.data as any).axis}
            onChange={(axis) =>
              setPrimitiveParams(node.id, { kind: "disk", data: { ...node.params.data as any, axis } })
            }
          />
        </Section>
      );
    case "triangular_prism":
      return (
        <Section title="Parameters">
          <NumberField
            label="Base"
            value={node.params.data.base}
            onChange={(base) =>
              setPrimitiveParams(node.id, { kind: "triangular_prism", data: { ...node.params.data as any, base } })
            }
            min={0}
          />
          <NumberField
            label="Height"
            value={node.params.data.triangleHeight}
            onChange={(triangleHeight) =>
              setPrimitiveParams(node.id, { kind: "triangular_prism", data: { ...node.params.data as any, triangleHeight } })
            }
            min={0}
          />
          <NumberField
            label="Depth"
            value={node.params.data.depth}
            onChange={(depth) =>
              setPrimitiveParams(node.id, { kind: "triangular_prism", data: { ...node.params.data as any, depth } })
            }
            min={0}
          />
          <AxisField
            label="Axis"
            value={(node.params.data as any).axis}
            onChange={(axis) =>
              setPrimitiveParams(node.id, { kind: "triangular_prism", data: { ...node.params.data as any, axis } })
            }
          />
        </Section>
      );
  }
}

// ── Main Inspector ────────────────────────────────────────────

export default function BuilderPrimitiveInspector({
  primitiveId,
}: {
  primitiveId: string;
}) {
  const node = useGeometryBuilderStore((s) => s.getPrimitive(primitiveId));
  const dirty = useGeometryBuilderStore((s) => s.dirty);
  const renamePrimitive = useGeometryBuilderStore((s) => s.renamePrimitive);
  const setPrimitiveTransform = useGeometryBuilderStore((s) => s.setPrimitiveTransform);
  const setPrimitiveVisible = useGeometryBuilderStore((s) => s.setPrimitiveVisible);
  const setPrimitiveEnabled = useGeometryBuilderStore((s) => s.setPrimitiveEnabled);
  const setPrimitiveLocked = useGeometryBuilderStore((s) => s.setPrimitiveLocked);
  const duplicatePrimitive = useGeometryBuilderStore((s) => s.duplicatePrimitive);
  const removePrimitive = useGeometryBuilderStore((s) => s.removePrimitive);
  const validateNode = useGeometryBuilderStore((s) => s.validateNode);

  const validation = useMemo(
    () => (node ? validateNode(node.id) : null),
    [node, validateNode],
  );

  if (!node) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Primitive not found.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-3 text-sm">
      {/* ── Identity ─────────────────────────────────────────── */}
      <Section title="Identity">
        <div className="flex items-center gap-2">
          {PRIMITIVE_ICONS[node.primitiveKind]}
          <span className="text-xs text-muted-foreground">{PRIMITIVE_LABELS[node.primitiveKind]}</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="w-20 text-xs text-muted-foreground shrink-0">Name</label>
          <input
            type="text"
            className="flex-1 bg-muted/50 border border-border rounded px-2 py-1 text-xs text-foreground"
            value={node.name}
            onChange={(e) => renamePrimitive(node.id, e.target.value)}
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          <ToggleButton
            active={node.visible}
            onClick={() => setPrimitiveVisible(node.id, !node.visible)}
            iconOn={<Eye size={12} />}
            iconOff={<EyeOff size={12} />}
            label="Visible"
          />
          <ToggleButton
            active={node.enabled}
            onClick={() => setPrimitiveEnabled(node.id, !node.enabled)}
            iconOn={<Power size={12} />}
            iconOff={<PowerOff size={12} />}
            label="Enabled"
          />
          <ToggleButton
            active={node.locked}
            onClick={() => setPrimitiveLocked(node.id, !node.locked)}
            iconOn={<Lock size={12} />}
            iconOff={<Unlock size={12} />}
            label="Locked"
          />
        </div>
      </Section>

      {/* ── Parameters ───────────────────────────────────────── */}
      <ParamsSection node={node} />

      {/* ── Transform ────────────────────────────────────────── */}
      <Section title="Transform">
        <Vec3Field
          label="Position"
          value={node.transform.translation}
          onChange={(translation) =>
            setPrimitiveTransform(node.id, { ...node.transform, translation })
          }
        />
        <Vec3Field
          label="Scale"
          value={node.transform.scale}
          onChange={(scale) =>
            setPrimitiveTransform(node.id, { ...node.transform, scale })
          }
        />
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground underline"
          onClick={() =>
            setPrimitiveTransform(node.id, {
              translation: [0, 0, 0],
              rotationQuat: [0, 0, 0, 1],
              scale: [1, 1, 1],
            })
          }
        >
          Reset Transform
        </button>
      </Section>

      {/* ── Placement Diagnostics ────────────────────────────── */}
      {validation && (
        <Section title="Placement">
          {/* Preview-only capability warning */}
          {PRIMITIVE_CAPABILITIES[node.primitiveKind].status === "preview" && (
            <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-2 py-1.5 text-[10px] text-amber-400">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>
                <span className="font-semibold capitalize">{node.primitiveKind}</span> is preview-only for the current backend. Use Box or Cylinder for production meshes.
              </span>
            </div>
          )}

          {/* Overall placement status */}
          <div className="flex items-center gap-2">
            {validation.withinUniverse && !validation.selfInvalid ? (
              <CheckCircle size={14} className="text-emerald-400" />
            ) : (
              <XCircle size={14} className="text-red-400" />
            )}
            <span className="text-xs">
              {validation.withinUniverse && !validation.selfInvalid
                ? "Within Universe bounds"
                : "Placement issues detected"}
            </span>
          </div>

          {/* Diagnostic messages */}
          {validation.diagnostics.map((diag, i) => (
            <div
              key={`${diag.code}-${i}`}
              className={`flex items-start gap-2 text-xs ${
                diag.severity === "error"
                  ? "text-red-400"
                  : diag.severity === "warning"
                    ? "text-amber-400"
                    : "text-muted-foreground"
              }`}
            >
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>{diag.message}</span>
            </div>
          ))}

          {/* Suggested actions */}
          {validation.suggestedActions.length > 0 && (
            <div className="space-y-1 pt-1">
              <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Suggested actions</div>
              {validation.suggestedActions.map((action, i) => {
                if (action.kind === "expand_universe") {
                  return (
                    <button
                      key={i}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[10px] text-amber-400 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 transition-colors"
                      onClick={() => {
                        const { setUniverseSize, setUniverseOrigin } = useGeometryBuilderStore.getState();
                        setUniverseSize(action.requiredSize);
                        setUniverseOrigin(action.requiredOrigin);
                      }}
                    >
                      <Maximize2 size={11} className="shrink-0" />
                      <span>Expand Universe to fit</span>
                      <ArrowRight size={10} className="ml-auto shrink-0" />
                    </button>
                  );
                }
                if (action.kind === "move_inside") {
                  return (
                    <button
                      key={i}
                      type="button"
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[10px] text-sky-400 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/20 transition-colors"
                      onClick={() => {
                        const { setPrimitiveTransform, getPrimitive } = useGeometryBuilderStore.getState();
                        const p = getPrimitive(node.id);
                        if (p) {
                          setPrimitiveTransform(node.id, {
                            ...p.transform,
                            translation: action.suggestedTranslation,
                          });
                        }
                      }}
                    >
                      <ArrowRight size={11} className="shrink-0" />
                      <span>Move inside Universe</span>
                      <ArrowRight size={10} className="ml-auto shrink-0" />
                    </button>
                  );
                }
                if (action.kind === "clip_with_ack") {
                  return (
                    <div
                      key={i}
                      className="flex items-start gap-2 rounded-md px-2 py-1.5 text-[10px] text-muted-foreground bg-muted/30 border border-border/30"
                    >
                      <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                      <span>Clipping changes solver geometry — confirm in Universe inspector before building.</span>
                    </div>
                  );
                }
                return null;
              })}
            </div>
          )}
        </Section>
      )}

      {/* ── Lifecycle ────────────────────────────────────────── */}
      <Section title="Lifecycle">
        <div className="text-xs text-muted-foreground space-y-1">
          <div>
            Geometry draft: {dirty.geometryDraftDirty ? "⚠ modified" : "✓ clean"}
          </div>
          <div>
            Realization: {dirty.geometryRealizationDirty ? "⚠ out of date" : "✓ current"}
          </div>
          <div>
            Mesh: {dirty.meshDirty ? "⚠ out of date" : "✓ current"}
          </div>
        </div>
      </Section>

      {/* ── Actions ──────────────────────────────────────────── */}
      <Section title="Actions">
        <div className="flex gap-1">
          <button
            type="button"
            className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => duplicatePrimitive(node.id)}
            title="Duplicate"
          >
            <Copy size={12} />
            Duplicate
          </button>
          <button
            type="button"
            className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-red-500/10 text-red-400 hover:bg-red-500/20"
            onClick={() => removePrimitive(node.id)}
            title="Delete"
          >
            <Trash2 size={12} />
            Delete
          </button>
        </div>
      </Section>
    </div>
  );
}
