/**
 * P2 — Geometry Builder ribbon contributions.
 *
 * Provides ribbon groups for the Geometry Builder mode:
 * - Create (primitives)
 * - Transform (move/rotate/scale)
 * - Viewport Mode (camera/manipulate toggle)
 * - Geometry Lifecycle (build geometry, build mesh, validate)
 * - Focus (focus selected, frame all, show universe)
 */

import {
  Box,
  Circle,
  Cylinder,
  Disc,
  Triangle,
  Move,
  RotateCcw,
  Maximize2,
  Camera,
  MousePointer2,
  Hammer,
  Grid3x3,
  CheckCircle,
  Focus,
  Maximize,
  Eye,
  Magnet,
  AlertTriangle,
  Plus,
  Minus,
  Combine,
} from "lucide-react";
import type React from "react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";
import {
  PRIMITIVE_CAPABILITIES,
  type PrimitiveKind,
} from "@/features/geometry-builder/model/types";
import { useGeometryBuilderStore } from "@/features/geometry-builder/store/useGeometryBuilderStore";

const CREATE_SHAPES: Array<{ kind: PrimitiveKind; icon: React.ReactNode; color: string }> = [
  { kind: "box", icon: <Box size={20} />, color: "text-emerald-400" },
  { kind: "cylinder", icon: <Cylinder size={20} />, color: "text-cyan-400" },
  { kind: "sphere", icon: <Circle size={20} />, color: "text-violet-400" },
  { kind: "ellipsoid", icon: <Circle size={20} />, color: "text-purple-300" },
  { kind: "disk", icon: <Disc size={20} />, color: "text-sky-400" },
  { kind: "thin_film", icon: <Box size={20} />, color: "text-lime-300" },
  { kind: "pillar", icon: <Cylinder size={20} />, color: "text-fuchsia-300" },
  { kind: "nanowire", icon: <Minus size={20} />, color: "text-rose-300" },
  { kind: "ring", icon: <Circle size={20} />, color: "text-amber-300" },
  { kind: "triangular_prism", icon: <Triangle size={20} />, color: "text-orange-300" },
  { kind: "cone", icon: <Triangle size={20} />, color: "text-yellow-300" },
  { kind: "capsule", icon: <Disc size={20} />, color: "text-teal-300" },
  { kind: "tube", icon: <Circle size={20} />, color: "text-blue-300" },
  { kind: "wedge", icon: <Box size={20} />, color: "text-stone-300" },
  { kind: "polygon_prism", icon: <Circle size={20} />, color: "text-indigo-300" },
];

function buildGeometryBuilderGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const groups: RibbonGroup[] = [];

  // ── Create group ────────────────────────────────────────────
  groups.push({
    id: "builder-create",
    title: "Create Object / Shape",
    subtitle: "Parametric primitives",
    tone: "authoring",
    actions: CREATE_SHAPES.map(({ kind, icon, color }) => {
      const capability = PRIMITIVE_CAPABILITIES[kind];
      const backendReady = ctx.isFemBackend ? capability.fem : capability.fdm;
      return {
        id: `builder-add-${kind}`,
        icon,
        label: capability.label,
        tooltip: backendReady
          ? `Create ${capability.label}.`
          : `Create ${capability.label} preview. Mesh build is blocked until this shape is supported by the active backend.`,
        action: () => ctx.run({ id: "builder.add-primitive", primitiveKind: kind }),
        iconColor: backendReady ? color : "text-slate-400",
      };
    }),
  });

  groups.push({
    id: "builder-boolean",
    title: "Boolean",
    subtitle: "Compose object geometry",
    tone: "authoring",
    actions: [
      {
        id: "builder-boolean-union",
        icon: <Combine size={20} />,
        label: "Union",
        tooltip: "Combine enabled shapes into one object body.",
        action: () => ctx.run({ id: "builder.create-boolean", op: "union" }),
        iconColor: "text-emerald-300",
      },
      {
        id: "builder-boolean-subtract",
        icon: <Minus size={20} />,
        label: "Subtract",
        tooltip: "Use enabled shapes as a subtractive boolean graph.",
        action: () => ctx.run({ id: "builder.create-boolean", op: "subtract" }),
        iconColor: "text-rose-300",
      },
      {
        id: "builder-boolean-intersect",
        icon: <Plus size={20} />,
        label: "Intersect",
        tooltip: "Create an intersection boolean graph from enabled shapes.",
        action: () => ctx.run({ id: "builder.create-boolean", op: "intersect" }),
        iconColor: "text-sky-300",
      },
    ],
  });

  // ── Transform group ─────────────────────────────────────────
  const hasPrimitiveSelection = Boolean(ctx.builderSelectedPrimitiveId);
  const hasTransformSelection = Boolean(ctx.selectedObjectId || ctx.builderSelectedPrimitiveId);

  groups.push({
    id: "builder-transform",
    title: "Transform",
    subtitle: "Move / Rotate / Scale",
    tone: "authoring",
    actions: [
      {
        id: "builder-tool-move",
        icon: <Move size={20} />,
        label: "Move",
        tooltip: "Translate selected object or primitive (W)",
        shortcut: "W",
        active: ctx.activeTransformScope === "object",
        disabled: !hasTransformSelection,
        action: () => ctx.run({ id: "builder.set-transform-tool", tool: "move" }),
        iconColor: "text-red-400",
      },
      {
        id: "builder-tool-rotate",
        icon: <RotateCcw size={20} />,
        label: "Rotate",
        tooltip: "Rotate selected object or primitive (E)",
        shortcut: "E",
        disabled: !hasTransformSelection,
        action: () => ctx.run({ id: "builder.set-transform-tool", tool: "rotate" }),
        iconColor: "text-green-400",
      },
      {
        id: "builder-tool-scale",
        icon: <Maximize2 size={20} />,
        label: "Scale",
        tooltip: "Scale selected object or primitive (R)",
        shortcut: "R",
        disabled: !hasTransformSelection,
        action: () => ctx.run({ id: "builder.set-transform-tool", tool: "scale" }),
        iconColor: "text-blue-400",
      },
    ],
  });

  // ── Viewport Mode group ─────────────────────────────────────
  groups.push({
    id: "builder-viewport-mode",
    title: "Viewport",
    subtitle: "Interaction mode",
    tone: "neutral",
    actions: [
      {
        id: "builder-mode-camera",
        icon: <Camera size={20} />,
        label: "Camera",
        tooltip: "Switch to camera navigation mode (Q)",
        shortcut: "Q",
        active: ctx.viewMode === "camera",
        action: () => ctx.run({ id: "builder.set-viewport-mode", mode: "camera" }),
        iconColor: "text-slate-300",
      },
      {
        id: "builder-mode-manipulate",
        icon: <MousePointer2 size={20} />,
        label: "Manipulate",
        tooltip: "Switch to gizmo manipulation mode",
        active: ctx.viewMode === "manipulate",
        action: () => ctx.run({ id: "builder.set-viewport-mode", mode: "manipulate" }),
        iconColor: "text-orange-400",
      },
      {
        id: "builder-toggle-snap",
        icon: <Magnet size={20} />,
        label: "Snap",
        tooltip: "Toggle snap to grid (G)",
        shortcut: "G",
        action: () => ctx.run({ id: "builder.toggle-snap" }),
        iconColor: "text-slate-400",
      },
    ],
  });

  // ── Geometry Lifecycle group ────────────────────────────────
  const isDirtyGeometry = Boolean(ctx.builderDirtyGeometry);
  const isDirtyMesh = Boolean(ctx.builderDirtyMesh);
  const buildTargetLabel = ctx.isFemBackend ? "FEM Mesh" : "FDM Grid";
  const backendBlockedReason = useGeometryBuilderStore
    .getState()
    .getBackendBuildBlockedReason(ctx.isFemBackend);

  groups.push({
    id: "builder-lifecycle",
    title: "Lifecycle",
    subtitle: isDirtyGeometry
      ? "⚠ Geometry changed"
      : isDirtyMesh
        ? "⚠ Mesh out of date"
        : "✓ Ready",
    tone: isDirtyGeometry || isDirtyMesh ? "sync" : "neutral",
    actions: [
      {
        id: "builder-build-geometry",
        icon: <Hammer size={20} />,
        label: "Build Geometry",
        tooltip: "Realize authoring geometry for solver",
        accent: isDirtyGeometry,
        disabled: !isDirtyGeometry,
        action: () => ctx.run({ id: "builder.build-geometry" }),
        iconColor: isDirtyGeometry ? "text-amber-400" : "text-slate-400",
      },
      {
        id: "builder-build-mesh",
        icon: <Grid3x3 size={20} />,
        label: `Build ${buildTargetLabel}`,
        tooltip: backendBlockedReason ?? `Generate solver ${buildTargetLabel.toLowerCase()} from realized geometry`,
        accent: isDirtyMesh && !isDirtyGeometry,
        disabled: Boolean(backendBlockedReason) || isDirtyGeometry || !isDirtyMesh || !ctx.builderHasRealization,
        action: () => ctx.run({ id: "builder.build-mesh" }),
        iconColor: backendBlockedReason ? "text-rose-400" : isDirtyMesh ? "text-amber-400" : "text-slate-400",
      },
      {
        id: "builder-validate",
        icon: <CheckCircle size={20} />,
        label: "Validate",
        tooltip: "Run placement validation on all primitives",
        action: () => ctx.run({ id: "builder.validate-geometry" }),
        iconColor: "text-emerald-400",
      },
    ],
  });

  // ── Focus group ─────────────────────────────────────────────
  groups.push({
    id: "builder-focus",
    title: "Focus",
    subtitle: "Camera commands",
    tone: "neutral",
    actions: [
      {
        id: "builder-focus-selected",
        icon: <Focus size={20} />,
        label: "Focus Selected",
        tooltip: "Focus camera on selected primitive (F)",
        shortcut: "F",
        disabled: !hasPrimitiveSelection,
        action: () => ctx.run({ id: "builder.focus-selected" }),
        iconColor: "text-slate-300",
      },
      {
        id: "builder-frame-all",
        icon: <Maximize size={20} />,
        label: "Frame All",
        tooltip: "Fit camera to show all objects (Shift+F)",
        shortcut: "Shift+F",
        action: () => ctx.run({ id: "builder.frame-all" }),
        iconColor: "text-slate-300",
      },
      {
        id: "builder-show-universe",
        icon: <Eye size={20} />,
        label: "Show Universe",
        tooltip: "Toggle Universe bounds visibility",
        action: () => ctx.run({ id: "navigation.select-node", nodeId: "universe" }),
        iconColor: "text-cyan-400",
      },
    ],
  });

  return groups;
}

registerRibbonContribution({
  tab: "geometry",
  priority: 10,
  buildGroups: buildGeometryBuilderGroups,
});
