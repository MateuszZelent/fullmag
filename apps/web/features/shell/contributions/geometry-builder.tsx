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
} from "lucide-react";
import { registerRibbonContribution } from "../registry/ribbonRegistry";
import type { RibbonBuildContext, RibbonGroup } from "../registry/ribbonRegistry";

function buildGeometryBuilderGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  const groups: RibbonGroup[] = [];

  // ── Create group ────────────────────────────────────────────
  groups.push({
    id: "builder-create",
    title: "Create",
    subtitle: "Add primitives",
    tone: "authoring",
    actions: [
      {
        id: "builder-add-box",
        icon: <Box size={20} />,
        label: "Box",
        tooltip: "Create a parametric box (W)",
        shortcut: "Shift+B",
        action: () => ctx.run({ id: "builder.add-primitive", primitiveKind: "box" }),
        iconColor: "text-emerald-400",
      },
      {
        id: "builder-add-cylinder",
        icon: <Cylinder size={20} />,
        label: "Cylinder",
        tooltip: "Create a parametric cylinder",
        action: () => ctx.run({ id: "builder.add-primitive", primitiveKind: "cylinder" }),
        iconColor: "text-cyan-400",
      },
      {
        id: "builder-add-sphere",
        icon: <Circle size={20} />,
        label: "Sphere",
        tooltip: "Create a parametric sphere",
        action: () => ctx.run({ id: "builder.add-primitive", primitiveKind: "sphere" }),
        iconColor: "text-violet-400",
      },
      {
        id: "builder-add-disk",
        icon: <Disc size={20} />,
        label: "Disk",
        tooltip: "Create a thin circular disk",
        action: () => ctx.run({ id: "builder.add-primitive", primitiveKind: "disk" }),
        iconColor: "text-sky-400",
      },
      {
        id: "builder-add-triangle",
        icon: <Triangle size={20} />,
        label: "Triangle",
        tooltip: "Create a triangular prism",
        action: () => ctx.run({ id: "builder.add-primitive", primitiveKind: "triangular_prism" }),
        iconColor: "text-amber-400",
      },
    ],
  });

  // ── Transform group ─────────────────────────────────────────
  const hasPrimitiveSelection = Boolean(ctx.builderSelectedPrimitiveId);

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
        tooltip: "Translate selected primitive (W)",
        shortcut: "W",
        active: ctx.activeTransformScope === "object",
        disabled: !hasPrimitiveSelection,
        action: () => ctx.run({ id: "builder.set-transform-tool", tool: "move" }),
        iconColor: "text-red-400",
      },
      {
        id: "builder-tool-rotate",
        icon: <RotateCcw size={20} />,
        label: "Rotate",
        tooltip: "Rotate selected primitive (E)",
        shortcut: "E",
        disabled: !hasPrimitiveSelection,
        action: () => ctx.run({ id: "builder.set-transform-tool", tool: "rotate" }),
        iconColor: "text-green-400",
      },
      {
        id: "builder-tool-scale",
        icon: <Maximize2 size={20} />,
        label: "Scale",
        tooltip: "Scale selected primitive (R)",
        shortcut: "R",
        disabled: !hasPrimitiveSelection,
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
        label: "Build Mesh",
        tooltip: "Generate solver mesh from realized geometry",
        accent: isDirtyMesh && !isDirtyGeometry,
        disabled: isDirtyGeometry || !isDirtyMesh,
        action: () => ctx.run({ id: "builder.build-mesh" }),
        iconColor: isDirtyMesh ? "text-amber-400" : "text-slate-400",
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
