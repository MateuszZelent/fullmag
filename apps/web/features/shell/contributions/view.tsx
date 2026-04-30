import {
  Activity,
  Blend,
  Box,
  BoxSelect,
  Camera,
  Download,
  Hand,
  Info,
  Layers3,
  Monitor,
  Move3D,
  MousePointer2,
  PanelRight,
  Ruler,
  Scissors,
  Sigma,
  Sparkles,
  Zap,
} from "lucide-react";
import {
  registerRibbonContribution,
  type RibbonBuildContext,
  type RibbonGroup,
} from "../registry/ribbonRegistry";
import type { RibbonMenuNode } from "../registry/ribbonMenuTypes";
import type {
  AirboxDisplayScope,
  ViewportMeshRenderMode,
} from "@/components/shell/ribbon/command-registry";
import {
  GLYPH_BUDGET_MAX,
  GLYPH_BUDGET_MIN,
} from "@/components/preview/fem/vectorDensityBudget";

const QUANTITY_FALLBACKS = [
  { id: "m", label: "Magnetization / m" },
  { id: "H_eff", label: "Effective field / H_eff" },
  { id: "H_demag", label: "Demag field / H_demag" },
  { id: "H_ex", label: "Exchange field / H_ex" },
  { id: "H_anis", label: "Anisotropy field / H_anis" },
  { id: "energy_density", label: "Energy density" },
];

const VECTOR_COLOR_ITEMS = [
  { value: "orientation", label: "Orientation / HSL" },
  { value: "magnitude", label: "Magnitude" },
  { value: "x", label: "X component" },
  { value: "y", label: "Y component" },
  { value: "z", label: "Z component" },
  { value: "monochrome", label: "Monochrome" },
];

const VECTOR_COMPONENT_ITEMS = [
  { value: "3D", label: "3D vectors" },
  { value: "magnitude", label: "Magnitude |v|" },
  { value: "x", label: "X" },
  { value: "y", label: "Y" },
  { value: "z", label: "Z" },
];

function buildComponentMenuNode(
  ctx: RibbonBuildContext,
  id: string,
  label: string,
  component: "3D" | "x" | "y" | "z" | "magnitude",
  disabled: boolean,
  disabledReason: string | null,
): RibbonMenuNode {
  return {
    type: "radio-group",
    id,
    label,
    value: component,
    disabled,
    disabledReason,
    onValueChange: (value) =>
      ctx.run({
        id: "viewport.set-component",
        component: value as "3D" | "x" | "y" | "z" | "magnitude",
      }),
    items: VECTOR_COMPONENT_ITEMS,
  } as RibbonMenuNode;
}

const AIRBOX_EXTENT_ITEMS: Array<{ value: AirboxDisplayScope; label: string }> = [
  { value: "surface", label: "Surface" },
  { value: "full", label: "Full" },
];

const MESH_RENDER_ITEMS = [
  { value: "surface", label: "Shaded surface" },
  { value: "surface+edges", label: "Shaded + wireframe" },
  { value: "wireframe", label: "Wireframe" },
  { value: "points", label: "Points (nodes)" },
];

function noSessionReason(ctx: RibbonBuildContext): string | null {
  return ctx.can({ id: "viewport.set-mode", mode: "3D" }) ? null : "No active workspace session";
}

function canUse3D(ctx: RibbonBuildContext): { disabled: boolean; reason: string | null } {
  const reason = noSessionReason(ctx);
  if (reason) return { disabled: true, reason };
  if (ctx.viewMode !== "3D" && ctx.viewMode !== "Mesh") {
    return { disabled: true, reason: "Viewport is not in 3D/Mesh mode" };
  }
  return { disabled: false, reason: null };
}

function canUse3Dor2D(ctx: RibbonBuildContext): { disabled: boolean; reason: string | null } {
  const reason = noSessionReason(ctx);
  if (reason) return { disabled: true, reason };
  if (ctx.viewMode !== "3D" && ctx.viewMode !== "Mesh" && ctx.viewMode !== "2D") {
    return { disabled: true, reason: "Viewport is not in 3D/Mesh/2D mode" };
  }
  return { disabled: false, reason: null };
}

function canUse2D(ctx: RibbonBuildContext): { disabled: boolean; reason: string | null } {
  const reason = noSessionReason(ctx);
  if (reason) return { disabled: true, reason };
  if (ctx.viewMode !== "2D") {
    return { disabled: true, reason: "Switch to 2D Slice to edit slice controls" };
  }
  if (!ctx.slice2DToolbar) {
    return { disabled: true, reason: "2D Slice model is not ready" };
  }
  return { disabled: false, reason: null };
}

function canUseObjectView(ctx: RibbonBuildContext): { disabled: boolean; reason: string | null } {
  const base = canUse3Dor2D(ctx);
  if (base.disabled) {
    return base;
  }
  return { disabled: false, reason: null };
}

function canUseSelected(ctx: RibbonBuildContext): { disabled: boolean; reason: string | null } {
  const global = canUse3D(ctx);
  if (global.disabled) return global;
  if (!ctx.selectedObjectId) {
    return { disabled: true, reason: "Select object to edit object display" };
  }
  return { disabled: false, reason: null };
}

function quantityOptions(ctx: RibbonBuildContext) {
  const fromRuntime = ctx.quickPreviewTargets.map((target) => ({
    value: target.id,
    label: target.shortLabel,
    disabled: !target.available,
    disabledReason: target.available ? null : "Quantity is not available for this run",
  }));
  return fromRuntime.length > 0
    ? fromRuntime
    : QUANTITY_FALLBACKS.map((target) => ({ value: target.id, label: target.label }));
}

function buildQuantityMenu(ctx: RibbonBuildContext): RibbonMenuNode[] {
  const global = canUse3Dor2D(ctx);
  const quantityStatus = ctx.requestedPreviewQuantityDataStatus ?? (ctx.previewPending ? "pending" : "ready");
  const autoScale = Boolean(ctx.requestedPreviewAutoScale ?? true);
  const scalarReason = ctx.isFemBackend
    ? "FEM explicit topology may expose orientation/component coloring before scalar colormap support."
    : null;

  return [
    { type: "label", id: "quantity:header", label: "Active quantity", badge: quantityStatus },
    { type: "status", id: "quantity:current", label: "Current", value: ctx.selectedQuantity ?? "None" },
    {
      type: "checkbox",
      id: "quantity:overlay-visible",
      label: "Quantity overlay on/off",
      checked: ctx.quantityShaderVisible,
      disabled: global.disabled,
      disabledReason: global.reason,
      onCheckedChange: (visible) => ctx.run({ id: "viewport.toggle-quantity-shader", visible }),
    },
    { type: "separator", id: "quantity:s0" },
    {
      type: "radio-group",
      id: "quantity:source",
      label: "Quantity source",
      value: ctx.selectedQuantity ?? "",
      disabled: global.disabled,
      disabledReason: global.reason,
      onValueChange: (quantityId) => ctx.run({ id: "viewport.set-quantity", quantityId }),
      items: quantityOptions(ctx),
    },
    { type: "separator", id: "quantity:s1" },
    {
      type: "submenu",
      id: "quantity:colormap",
      label: "Colormap",
      nodes: [
        {
          type: "radio-group",
          id: "quantity:shader",
          label: "Shader coloring",
          value: "viridis",
          disabled: global.disabled || Boolean(scalarReason),
          disabledReason: global.reason ?? scalarReason,
          onValueChange: (colormap) => ctx.run({ id: "viewport.set-colormap", colormap }),
          items: ["viridis", "inferno", "magma", "coolwarm", "jet"].map((value) => ({
            value,
            label: value,
          })),
        },
        {
          type: "checkbox",
          id: "quantity:auto-scale",
          label: "Auto-scale range",
          checked: autoScale,
          disabled: global.disabled,
          disabledReason: global.reason,
          onCheckedChange: (enabled) => ctx.run({ id: "viewport.set-auto-scale", enabled }),
        },
        { type: "separator", id: "quantity:colormap:s0" },
        {
          type: "radio-group",
          id: "quantity:vector-coloring",
          label: "Vector coloring",
          value: ctx.femArrowColorMode ?? "orientation",
          disabled: global.disabled,
          disabledReason: global.reason,
          onValueChange: (colorMode) =>
            ctx.run({
              id: "viewport.set-vector-style",
              patch: { colorMode: colorMode as "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome" },
            }),
          items: VECTOR_COLOR_ITEMS,
        },
        {
          type: "color",
          id: "quantity:vector-mono-color",
          label: "Monochrome vector color",
          value: ctx.femArrowMonoColor ?? "#38d9ff",
          disabled: global.disabled || ctx.femArrowColorMode !== "monochrome",
          disabledReason: ctx.femArrowColorMode === "monochrome" ? global.reason : "Use Monochrome vector coloring first",
          onValueChange: (monoColor) => ctx.run({ id: "viewport.set-vector-style", patch: { monoColor } }),
        },
      ],
    },
  ];
}

function buildPrimitiveMenu(ctx: RibbonBuildContext): RibbonMenuNode[] {
  const global = canUse3D(ctx);
  const textureDensity = ctx.magneticTextureDensity ?? 65_536;
  const meshRenderMode = (ctx.meshRenderMode ?? "surface") as ViewportMeshRenderMode;
  const component = (ctx.requestedPreviewComponent ?? "magnitude") as
    | "3D"
    | "x"
    | "y"
    | "z"
    | "magnitude";
  return [
    {
      type: "label",
      id: "primitive:header",
      label: "Primitive display",
      badge: ctx.primitiveVisible ? "on" : "off",
    },
    {
      type: "status",
      id: "primitive:scope",
      label: "Scope",
      value: "Global ferromagnet base shading",
    },
    {
      type: "checkbox",
      id: "primitive:visible",
      label: "Primitive on/off",
      checked: ctx.primitiveVisible,
      disabled: global.disabled,
      disabledReason: global.reason,
      onCheckedChange: (visible) => ctx.run({ id: "viewport.toggle-primitives", visible }),
    },
    {
      type: "checkbox",
      id: "primitive:texture-visible",
      label: "Texture on/off",
      checked: ctx.magneticTextureVisible,
      disabled: global.disabled,
      disabledReason: global.reason,
      onCheckedChange: (visible) => ctx.run({ id: "viewport.toggle-magnetic-texture", visible }),
    },
    { type: "separator", id: "primitive:s0" },
    {
      type: "radio-group",
      id: "primitive:mesh-display",
      label: "Mesh display",
      value: meshRenderMode,
      disabled: global.disabled,
      disabledReason: global.reason,
      onValueChange: (renderMode) =>
        ctx.run({
          id: "viewport.set-global-render-mode",
          renderMode: renderMode as ViewportMeshRenderMode,
        }),
      items: MESH_RENDER_ITEMS,
    },
    buildComponentMenuNode(
      ctx,
      "primitive:texture-component",
      "Primitive texture",
      component === "3D" ? "3D" : component,
      global.disabled,
      global.reason,
    ),
    {
      type: "slider",
      id: "primitive:texture-density",
      label: "Texture downsample cells",
      value: textureDensity,
      min: 8,
      max: 131072,
      step: 8,
      disabled: global.disabled,
      disabledReason: global.reason,
      onValueChange: (density) => ctx.run({ id: "viewport.set-magnetic-texture-density", density }),
    },
  ];
}

function buildVectorsMenu(ctx: RibbonBuildContext): RibbonMenuNode[] {
  const global = canUse3Dor2D(ctx);
  const visible = Boolean(ctx.meshShowArrows);
  const warning = visible && ctx.previewPending ? "Vectors requested while preview data is pending" : null;
  const component = (ctx.requestedPreviewComponent ?? "magnitude") as
    | "3D"
    | "x"
    | "y"
    | "z"
    | "magnitude";
  const vectorBudget = ctx.femVectorGlyphBudget ?? 1_200;
  return [
    { type: "label", id: "vectors:header", label: "Field arrows", badge: warning ? "warning" : visible ? "on" : "off" },
    ...(warning ? [{ type: "status", id: "vectors:warning", label: "Hidden reason", value: warning, tone: "warning" } as RibbonMenuNode] : []),
    {
      type: "checkbox",
      id: "vectors:visible",
      label: "Show vectors / field arrows",
      checked: visible,
      disabled: global.disabled,
      disabledReason: global.reason,
      onCheckedChange: (next) => ctx.run({ id: "viewport.toggle-vectors", visible: next }),
    },
    {
      type: "slider",
      id: "vectors:density",
      label: "Vector glyph budget",
      value: vectorBudget,
      min: GLYPH_BUDGET_MIN,
      max: GLYPH_BUDGET_MAX,
      step: 8,
      disabled: global.disabled,
      disabledReason: global.reason,
      onValueChange: (budget) => ctx.run({ id: "viewport.set-vector-glyph-budget", glyphBudget: budget }),
    },
    buildComponentMenuNode(
      ctx,
      "vectors:component",
      "Vector component",
      component === "3D" ? "3D" : component,
      global.disabled,
      global.reason,
    ),
    {
      type: "submenu",
      id: "vectors:size",
      label: "Arrow size",
      nodes: [
        {
          type: "slider",
          id: "vectors:length",
          label: "Length scale",
          value: ctx.femArrowLengthScale ?? 1,
          min: 0.2,
          max: 4,
          step: 0.1,
          onValueChange: (lengthScale) => ctx.run({ id: "viewport.set-vector-style", patch: { lengthScale } }),
        },
        {
          type: "slider",
          id: "vectors:thickness",
          label: "Thickness",
          value: ctx.femArrowThickness ?? 1,
          min: 0.2,
          max: 4,
          step: 0.1,
          onValueChange: (thickness) => ctx.run({ id: "viewport.set-vector-style", patch: { thickness } }),
        },
        {
          type: "slider",
          id: "vectors:alpha",
          label: "Alpha",
          value: ctx.femArrowAlpha ?? 0.9,
          min: 0,
          max: 1,
          step: 0.05,
          onValueChange: (alpha) => ctx.run({ id: "viewport.set-vector-style", patch: { alpha } }),
        },
      ],
    },
    {
      type: "radio-group",
      id: "vectors:domain",
      label: "Vector domain",
      value: ctx.femVectorDomainFilter ?? "auto",
      onValueChange: (domain) =>
        ctx.run({
          id: "viewport.set-vector-style",
          patch: { domain: domain as "auto" | "magnetic_only" | "full_domain" | "airbox_only" },
        }),
      items: [
        { value: "auto", label: "Auto" },
        { value: "magnetic_only", label: "Magnetic objects only" },
        { value: "full_domain", label: "Full domain" },
        { value: "airbox_only", label: "Airbox only" },
      ],
    },
    {
      type: "radio-group",
      id: "vectors:colors",
      label: "Vector colors",
      value: ctx.femArrowColorMode ?? "orientation",
      onValueChange: (colorMode) =>
        ctx.run({
          id: "viewport.set-vector-style",
          patch: { colorMode: colorMode as "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome" },
        }),
      items: VECTOR_COLOR_ITEMS,
    },
  ];
}

function buildAirboxMenu(ctx: RibbonBuildContext): RibbonMenuNode[] {
  const global = canUse3D(ctx);
  const renderMode = ctx.airMeshRenderMode ?? "wireframe";
  const effectiveRenderMode = renderMode === "mesh" ? "wireframe" : renderMode;
  const wireframeScope = renderMode === "mesh" ? "full" : ctx.airMeshWireframeScope ?? "surface";
  const pointsScope = ctx.airMeshPointsScope ?? "surface";
  const vectorsScope = ctx.airMeshVectorsScope ?? "surface";
  const shaded = effectiveRenderMode === "surface" || effectiveRenderMode === "surface+edges";
  const wireframe = effectiveRenderMode === "wireframe" || effectiveRenderMode === "surface+edges";
  const points = effectiveRenderMode === "points";
  const geometryVisible =
    ctx.airMeshGeometryVisible ?? (shaded || wireframe || points);
  const pointsLayerOn = geometryVisible && points;
  const vectors = ctx.femVectorDomainFilter === "airbox_only" && Boolean(ctx.meshShowArrows);
  const airboxBadge = (() => {
    if (!ctx.airboxVisible) return "hidden";
    const parts: string[] = [];
    if (pointsLayerOn) parts.push(`points/${pointsScope}`);
    if (vectors) parts.push(`vectors/${vectorsScope}`);
    if (geometryVisible && wireframe) parts.push(`wire/${wireframeScope}`);
    if (geometryVisible && shaded) parts.push("shaded");
    return parts.length > 0 ? parts.join(" + ") : "visible";
  })();
  const pointsDisabled = global.disabled || !pointsLayerOn;
  const pointsDisabledReason = global.disabled
    ? global.reason
    : pointsLayerOn
      ? null
      : "Enable Airbox points first";
  const vectorsDisabled = global.disabled || !vectors;
  const vectorsDisabledReason = global.disabled
    ? global.reason
    : vectors
      ? null
      : "Enable Airbox vectors first";
  return [
    {
      type: "label",
      id: "airbox:header",
      label: "Airbox display",
      badge: airboxBadge,
    },
    {
      type: "checkbox",
      id: "airbox:visible",
      label: "Airbox on/off",
      checked: ctx.airboxVisible,
      disabled: global.disabled,
      disabledReason: global.reason,
      onCheckedChange: (visible) => ctx.run({ id: "viewport.set-airbox-display", patch: { visible } }),
    },
    { type: "separator", id: "airbox:s-primitive" },
    { type: "label", id: "airbox:primitive-section", label: "Primitive", badge: geometryVisible ? "on" : "off" },
    {
      type: "checkbox",
      id: "airbox:shaded",
      label: "Shaded on/off",
      checked: ctx.airboxVisible && geometryVisible && shaded,
      disabled: global.disabled,
      disabledReason: global.reason,
      onCheckedChange: (nextShaded) => ctx.run({ id: "viewport.set-airbox-display", patch: { shaded: nextShaded } }),
    },
    {
      type: "checkbox",
      id: "airbox:wireframe",
      label: "Wireframe on/off",
      checked: ctx.airboxVisible && geometryVisible && wireframe,
      disabled: global.disabled,
      disabledReason: global.reason,
      onCheckedChange: (nextWireframe) => ctx.run({ id: "viewport.set-airbox-display", patch: { wireframe: nextWireframe } }),
    },
    {
      type: "radio-group",
      id: "airbox:wireframe-scope",
      label: "Wireframe extent",
      value: wireframeScope,
      disabled: global.disabled,
      disabledReason: global.reason,
      onValueChange: (scope) =>
        ctx.run({
          id: "viewport.set-airbox-display",
          patch: { wireframeScope: scope as AirboxDisplayScope },
        }),
      items: AIRBOX_EXTENT_ITEMS,
    },
    { type: "separator", id: "airbox:s-points" },
    { type: "label", id: "airbox:points-section", label: "Points", badge: pointsLayerOn ? pointsScope : "off" },
    {
      type: "checkbox",
      id: "airbox:points",
      label: "Points on/off",
      checked: ctx.airboxVisible && geometryVisible && points,
      disabled: global.disabled,
      disabledReason: global.reason,
      onCheckedChange: (nextPoints) => ctx.run({ id: "viewport.set-airbox-display", patch: { points: nextPoints } }),
    },
    {
      type: "radio-group",
      id: "airbox:points-scope",
      label: "Points extent",
      value: pointsScope,
      disabled: pointsDisabled,
      disabledReason: pointsDisabledReason,
      onValueChange: (scope) =>
        ctx.run({
          id: "viewport.set-airbox-display",
          patch: { pointsScope: scope as AirboxDisplayScope },
        }),
      items: AIRBOX_EXTENT_ITEMS,
    },
    { type: "separator", id: "airbox:s-vectors" },
    { type: "label", id: "airbox:vectors-section", label: "Vectors", badge: vectors ? vectorsScope : "off" },
    {
      type: "checkbox",
      id: "airbox:vectors",
      label: "Vectors on/off",
      checked: vectors,
      disabled: global.disabled,
      disabledReason: global.reason,
      onCheckedChange: (nextVectors) => ctx.run({ id: "viewport.set-airbox-display", patch: { vectors: nextVectors } }),
    },
    {
      type: "radio-group",
      id: "airbox:vectors-scope",
      label: "Vectors extent",
      value: vectorsScope,
      disabled: vectorsDisabled,
      disabledReason: vectorsDisabledReason,
      onValueChange: (scope) =>
        ctx.run({
          id: "viewport.set-airbox-display",
          patch: { vectorsScope: scope as AirboxDisplayScope },
        }),
      items: AIRBOX_EXTENT_ITEMS,
    },
    {
      type: "submenu",
      id: "airbox:vectors-submenu",
      label: "Airbox vectors",
      nodes: [
        {
          type: "slider",
          id: "airbox:vectors-density",
          label: "Density / Every N",
          value: ctx.requestedPreviewEveryN ?? 4,
          min: 1,
          max: 64,
          step: 1,
          disabled: vectorsDisabled,
          disabledReason: vectorsDisabledReason,
          onValueChange: (everyN) => ctx.run({ id: "viewport.set-vector-density", everyN }),
        },
        {
          type: "slider",
          id: "airbox:vectors-length",
          label: "Length scale",
          value: ctx.femArrowLengthScale ?? 1,
          min: 0.2,
          max: 4,
          step: 0.1,
          disabled: vectorsDisabled,
          disabledReason: vectorsDisabledReason,
          onValueChange: (lengthScale) => ctx.run({ id: "viewport.set-vector-style", patch: { lengthScale } }),
        },
        {
          type: "slider",
          id: "airbox:vectors-thickness",
          label: "Thickness",
          value: ctx.femArrowThickness ?? 1,
          min: 0.2,
          max: 4,
          step: 0.1,
          disabled: vectorsDisabled,
          disabledReason: vectorsDisabledReason,
          onValueChange: (thickness) => ctx.run({ id: "viewport.set-vector-style", patch: { thickness } }),
        },
        {
          type: "slider",
          id: "airbox:vectors-alpha",
          label: "Alpha",
          value: ctx.femArrowAlpha ?? 0.9,
          min: 0,
          max: 1,
          step: 0.05,
          disabled: vectorsDisabled,
          disabledReason: vectorsDisabledReason,
          onValueChange: (alpha) => ctx.run({ id: "viewport.set-vector-style", patch: { alpha } }),
        },
      ],
    },
    {
      type: "submenu",
      id: "airbox:vector-colors",
      label: "Airbox vector colors",
      nodes: [
        {
          type: "radio-group",
          id: "airbox:vector-coloring",
          label: "Vector colors",
          value: ctx.femArrowColorMode ?? "orientation",
          disabled: vectorsDisabled,
          disabledReason: vectorsDisabledReason,
          onValueChange: (colorMode) =>
            ctx.run({
              id: "viewport.set-vector-style",
              patch: { colorMode: colorMode as "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome" },
            }),
          items: VECTOR_COLOR_ITEMS,
        },
        {
          type: "color",
          id: "airbox:vector-mono-color",
          label: "Monochrome vector color",
          value: ctx.femArrowMonoColor ?? "#38d9ff",
          disabled: vectorsDisabled || ctx.femArrowColorMode !== "monochrome",
          disabledReason: vectorsDisabled
            ? vectorsDisabledReason
            : ctx.femArrowColorMode === "monochrome"
              ? global.reason
              : "Use Monochrome vector coloring first",
          onValueChange: (monoColor) => ctx.run({ id: "viewport.set-vector-style", patch: { monoColor } }),
        },
      ],
    },
    { type: "separator", id: "airbox:s-visible" },
    {
      type: "slider",
      id: "airbox:opacity",
      label: "Opacity",
      value: ctx.airMeshOpacity ?? 35,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      disabled: global.disabled,
      disabledReason: global.reason,
      onValueChange: (opacity) => ctx.run({ id: "viewport.set-airbox-display", patch: { opacity } }),
    },
    { type: "separator", id: "airbox:s0" },
    { type: "item", id: "airbox:focus", label: "Focus airbox", disabled: true, disabledReason: "Airbox focus command is pending viewport preset support" },
    {
      type: "item",
      id: "airbox:reset",
      label: "Reset airbox display",
      action: () =>
        ctx.run({
          id: "viewport.set-airbox-display",
          patch: {
            visible: true,
            opacity: 35,
            shaded: false,
            wireframe: true,
            geometry: true,
            wireframeScope: "surface",
            points: false,
            pointsScope: "surface",
            vectors: false,
            vectorsScope: "surface",
          },
        }),
    },
  ];
}

function buildRenderLayersMenu(ctx: RibbonBuildContext): RibbonMenuNode[] {
  const global = canUse3Dor2D(ctx);
  return [
    {
      type: "radio-group",
      id: "layers:mesh-mode",
      label: "Mesh render mode",
      value: ctx.meshRenderMode ?? "surface",
      disabled: global.disabled,
      disabledReason: global.reason,
      onValueChange: (renderMode) =>
        ctx.run({
          id: "viewport.set-global-render-mode",
          renderMode: renderMode as ViewportMeshRenderMode,
        }),
      items: MESH_RENDER_ITEMS,
    },
    {
      type: "slider",
      id: "layers:opacity",
      label: "Mesh opacity",
      value: ctx.meshOpacity ?? 100,
      min: 0,
      max: 100,
      step: 1,
      unit: "%",
      disabled: global.disabled,
      disabledReason: global.reason,
      onValueChange: (opacity) => ctx.run({ id: "viewport.set-global-opacity", opacity }),
    },
    {
      type: "submenu",
      id: "layers:clip",
      label: "Global clip",
      nodes: [
        {
          type: "checkbox",
          id: "clip:enabled",
          label: "Clip enabled",
          checked: Boolean(ctx.meshClipEnabled),
          onCheckedChange: (enabled) => ctx.run({ id: "viewport.set-global-clip", patch: { enabled } }),
        },
        {
          type: "radio-group",
          id: "clip:axis",
          label: "Axis",
          value: ctx.meshClipAxis ?? "z",
          onValueChange: (axis) => ctx.run({ id: "viewport.set-global-clip", patch: { axis: axis as "x" | "y" | "z" } }),
          items: [
            { value: "x", label: "X" },
            { value: "y", label: "Y" },
            { value: "z", label: "Z" },
          ],
        },
        {
          type: "slider",
          id: "clip:position",
          label: "Position",
          value: ctx.meshClipPos ?? 50,
          min: 0,
          max: 100,
          step: 1,
          unit: "%",
          onValueChange: (position) => ctx.run({ id: "viewport.set-global-clip", patch: { position } }),
        },
        {
          type: "checkbox",
          id: "clip:flip",
          label: "Flip side",
          checked: Boolean(ctx.meshClipFlip),
          onCheckedChange: (flipped) => ctx.run({ id: "viewport.set-global-clip", patch: { flipped } }),
        },
      ],
    },
  ];
}

function buildGlobalDisplayGroup(ctx: RibbonBuildContext): RibbonGroup {
  const global = canUse3D(ctx);
  const vectorWarning = Boolean(ctx.meshShowArrows && ctx.previewPending);
  const viewport3DStatus = ctx.viewport3DStatus ?? "active";
  const viewport3DActive = viewport3DStatus === "active";
  const viewport3DReason =
    ctx.viewport3DStatusReason ??
    (viewport3DActive ? "3D visualization is rendering" : "3D visualization is not rendering");
  const viewport3DDetail = ctx.viewport3DStatusDetail ?? viewport3DReason;
  return {
    id: "view-global-display",
    title: "Global Display",
    subtitle: "3D render defaults",
    tone: "neutral",
    actions: [
      {
        id: "view-3d-status",
        icon: <Activity size={20} />,
        label: viewport3DActive ? "3D Active" : "3D Inactive",
        tooltip: viewport3DReason,
        active: viewport3DActive,
        state: viewport3DStatus === "warning" ? "warning" : viewport3DActive ? "active" : "default",
        iconColor:
          viewport3DStatus === "warning"
            ? "text-amber-300"
            : viewport3DActive
              ? "text-emerald-300"
              : "text-muted-foreground",
        menu: [
          {
            type: "label",
            id: "3d-status:header",
            label: "3D visualization",
            badge: viewport3DStatus === "warning" ? "warning" : viewport3DActive ? "active" : "inactive",
          },
          {
            type: "status",
            id: "3d-status:reason",
            label: viewport3DActive ? "Status" : "Hidden reason",
            value: viewport3DReason,
            tone: viewport3DStatus === "warning" ? "warning" : viewport3DActive ? "success" : "danger",
          },
          {
            type: "status",
            id: "3d-status:detail",
            label: "Detail",
            value: viewport3DDetail,
          },
        ],
      },
      {
        id: "view-primitive",
        icon: <Sparkles size={20} />,
        label: "Primitive",
        tooltip: "Control primitive visibility and primitive texture shading",
        active: ctx.primitiveVisible,
        disabled: global.disabled,
        iconColor: "text-teal-300",
        menu: buildPrimitiveMenu(ctx),
      },
      {
        id: "view-quantity",
        icon: <Sigma size={20} />,
        label: "Quantity",
        tooltip: "Choose field quantity, quantity overlay, component, colormap, and sampling",
        active: Boolean(ctx.selectedQuantity) || ctx.quantityShaderVisible,
        disabled: global.disabled,
        iconColor: "text-sky-300",
        menu: buildQuantityMenu(ctx),
      },
      {
        id: "view-vectors",
        icon: <Zap size={20} />,
        label: "Vectors",
        tooltip: "Control field arrows and vector coloring",
        active: Boolean(ctx.meshShowArrows),
        state: vectorWarning ? "warning" : Boolean(ctx.meshShowArrows) ? "active" : "default",
        disabled: global.disabled,
        iconColor: vectorWarning ? "text-amber-300" : "text-cyan-300",
        menu: buildVectorsMenu(ctx),
      },
      {
        id: "view-airbox",
        icon: <Box size={20} />,
        label: "Airbox",
        tooltip: "Control airbox visibility and vectors",
        active: ctx.airboxVisible,
        disabled: global.disabled,
        iconColor: "text-blue-300",
        menu: buildAirboxMenu(ctx),
      },
      {
        id: "view-render-layers",
        icon: <Layers3 size={20} />,
        label: "Mesh View",
        tooltip: "Control mesh render mode, opacity, and global clip",
        disabled: global.disabled,
        iconColor: "text-emerald-300",
        menu: buildRenderLayersMenu(ctx),
      },
    ],
  };
}

function buildSlice2DGroup(ctx: RibbonBuildContext): RibbonGroup {
  const slice = canUse2D(ctx);
  const toolbar = ctx.slice2DToolbar;
  const component = toolbar?.component ?? "magnitude";
  const axis = toolbar?.axis ?? "z";
  const mode = toolbar?.mode ?? "single";
  const renderMode = toolbar?.renderMode ?? "heatmap";
  const showQuantity = toolbar?.showQuantity ?? true;
  const showPrimitives = toolbar?.showPrimitives ?? true;
  const showMesh = toolbar?.showMesh ?? false;
  const showAirbox = toolbar?.showAirbox ?? false;
  const showVectors = toolbar?.showVectors ?? Boolean(ctx.meshShowArrows);
  const position = toolbar?.positionPercent ?? ctx.meshClipPos ?? 50;
  const autoScale = toolbar?.autoContrast ?? Boolean(ctx.requestedPreviewAutoScale ?? true);
  return {
    id: "view-slice-2d",
    title: "2D Slice",
    subtitle: ctx.viewMode === "2D" ? "Ribbon controls" : "Inactive",
    tone: "neutral",
    actions: [
      {
        id: "view-slice-quantity",
        icon: <Sigma size={20} />,
        label: "Quantity",
        tooltip: slice.reason ?? "Control 2D slice quantity and component",
        disabled: slice.disabled,
        iconColor: "text-sky-300",
        menu: [
          { type: "label", id: "slice:quantity:header", label: "Slice quantity", badge: ctx.selectedQuantity ?? toolbar?.quantityId ?? "m" },
          {
            type: "radio-group",
            id: "slice:quantity:source",
            label: "Quantity source",
            value: ctx.selectedQuantity ?? toolbar?.quantityId ?? "m",
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onValueChange: (quantityId) => ctx.run({ id: "viewport.set-quantity", quantityId }),
            items: quantityOptions(ctx),
          },
          {
            type: "radio-group",
            id: "slice:quantity:component",
            label: "Component",
            value: component,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onValueChange: (nextComponent) =>
              ctx.run({
                id: "viewport.set-component",
                component: nextComponent as "x" | "y" | "z" | "magnitude",
              }),
            items: [
              { value: "magnitude", label: "Magnitude |v|" },
              { value: "x", label: "X" },
              { value: "y", label: "Y" },
              { value: "z", label: "Z" },
            ],
          },
          {
            type: "checkbox",
            id: "slice:quantity:overlay",
            label: "Quantity overlay",
            checked: showQuantity,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onCheckedChange: (visible) => ctx.run({ id: "viewport.set-slice-quantity-overlay", visible }),
          },
          {
            type: "checkbox",
            id: "slice:quantity:auto-scale",
            label: "Auto-scale range",
            checked: autoScale,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onCheckedChange: (enabled) => ctx.run({ id: "viewport.set-auto-scale", enabled }),
          },
        ],
      },
      {
        id: "view-slice-vectors",
        icon: <Zap size={20} />,
        label: "Vectors",
        tooltip: slice.reason ?? "Control 2D vector overlay",
        active: showVectors,
        disabled: slice.disabled,
        iconColor: "text-cyan-300",
        menu: [
          {
            type: "checkbox",
            id: "slice:vectors:visible",
            label: "Show vectors",
            checked: showVectors,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onCheckedChange: (visible) =>
              ctx.run({
                id: "viewport.set-slice-render-mode",
                renderMode: visible ? "vectors" : "heatmap",
              }),
          },
          {
            type: "slider",
            id: "slice:vectors:density",
            label: "Every N",
            value: ctx.requestedPreviewEveryN ?? 4,
            min: 1,
            max: 64,
            step: 1,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onValueChange: (everyN) => ctx.run({ id: "viewport.set-vector-density", everyN }),
          },
          {
            type: "radio-group",
            id: "slice:vectors:colors",
            label: "Vector colors",
            value: ctx.femArrowColorMode ?? "orientation",
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onValueChange: (colorMode) =>
              ctx.run({
                id: "viewport.set-vector-style",
                patch: { colorMode: colorMode as "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome" },
              }),
            items: VECTOR_COLOR_ITEMS,
          },
        ],
      },
      {
        id: "view-slice-airbox",
        icon: <Box size={20} />,
        label: "Airbox",
        tooltip: slice.reason ?? "Control 2D airbox visibility and rendering",
        active: showAirbox,
        disabled: slice.disabled,
        iconColor: "text-fuchsia-300",
        menu: [
          { type: "label", id: "slice:airbox:header", label: "2D airbox", badge: showAirbox ? "visible" : "hidden" },
          {
            type: "checkbox",
            id: "slice:airbox:visible",
            label: "Airbox on/off",
            checked: showAirbox,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onCheckedChange: (visible) => {
              ctx.run({ id: "viewport.set-slice-airbox", visible });
              ctx.run({ id: "viewport.set-airbox-display", patch: { visible } });
            },
          },
          {
            type: "radio-group",
            id: "slice:airbox:render-mode",
            label: "Airbox render",
            value: ctx.airMeshRenderMode ?? "wireframe",
            disabled: slice.disabled || !showAirbox,
            disabledReason: slice.reason ?? (!showAirbox ? "Enable airbox first" : undefined),
            onValueChange: (meshRenderMode) =>
              ctx.run({
                id: "viewport.set-airbox-display",
                patch: { renderMode: meshRenderMode as "surface" | "wireframe" | "surface+edges" | "points" },
              }),
            items: [
              { value: "surface", label: "Shaded" },
              { value: "wireframe", label: "Wireframe" },
              { value: "surface+edges", label: "Shaded + wireframe" },
              { value: "points", label: "Points" },
            ],
          },
          {
            type: "checkbox",
            id: "slice:airbox:vectors",
            label: "Vectors",
            checked: showVectors && ctx.femVectorDomainFilter === "airbox_only",
            disabled: slice.disabled || !showAirbox,
            disabledReason: slice.reason ?? (!showAirbox ? "Enable airbox first" : undefined),
            onCheckedChange: (visible) => {
              ctx.run({ id: "viewport.set-airbox-display", patch: { vectors: visible } });
              ctx.run({ id: "viewport.set-slice-render-mode", renderMode: visible ? "vectors" : "heatmap" });
            },
          },
        ],
      },
      {
        id: "view-slice-layers",
        icon: <Layers3 size={20} />,
        label: "Layers",
        tooltip: slice.reason ?? "Control 2D render layers and render mode",
        disabled: slice.disabled,
        iconColor: "text-emerald-300",
        menu: [
          {
            type: "checkbox",
            id: "slice:mesh:primitives",
            label: "Primitives",
            checked: showPrimitives,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onCheckedChange: (visible) => ctx.run({ id: "viewport.set-slice-primitives", visible }),
          },
          {
            type: "checkbox",
            id: "slice:mesh:wireframe",
            label: "Mesh wireframe",
            checked: showMesh,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onCheckedChange: (visible) => ctx.run({ id: "viewport.set-slice-mesh", visible }),
          },
          {
            type: "checkbox",
            id: "slice:layers:quantity",
            label: "Quantity overlay",
            checked: showQuantity,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onCheckedChange: (visible) => ctx.run({ id: "viewport.set-slice-quantity-overlay", visible }),
          },
          { type: "separator", id: "slice:mesh:s0" },
          {
            type: "radio-group",
            id: "slice:layers:render-mode",
            label: "Slice render",
            value: renderMode,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onValueChange: (nextRenderMode) =>
              ctx.run({
                id: "viewport.set-slice-render-mode",
                renderMode: nextRenderMode as "heatmap" | "contour" | "heatmap+contour" | "vectors" | "mesh-overlay",
              }),
            items: [
              { value: "heatmap", label: "Heatmap" },
              { value: "contour", label: "Contour" },
              { value: "heatmap+contour", label: "Heatmap + contour" },
              { value: "vectors", label: "Vectors" },
              { value: "mesh-overlay", label: "Mesh overlay" },
            ],
          },
          {
            type: "radio-group",
            id: "slice:mesh:render-mode",
            label: "Mesh render mode",
            value: ctx.meshRenderMode ?? "surface",
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onValueChange: (meshRenderMode) =>
              ctx.run({
                id: "viewport.set-global-render-mode",
                renderMode: meshRenderMode as "surface" | "wireframe" | "surface+edges" | "points",
              }),
            items: [
              { value: "surface", label: "Shaded" },
              { value: "wireframe", label: "Wireframe" },
              { value: "surface+edges", label: "Shaded + wireframe" },
              { value: "points", label: "Points" },
            ],
          },
        ],
      },
      {
        id: "view-slice-plane",
        icon: <Scissors size={20} />,
        label: "Plane",
        tooltip: slice.reason ?? "Set 2D slice axis, mode, and position",
        disabled: slice.disabled,
        iconColor: "text-orange-300",
        menu: [
          {
            type: "radio-group",
            id: "slice:plane:axis",
            label: "Axis",
            value: axis,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onValueChange: (nextAxis) => ctx.run({ id: "viewport.set-slice-axis", axis: nextAxis as "x" | "y" | "z" }),
            items: [
              { value: "x", label: "X normal / YZ" },
              { value: "y", label: "Y normal / XZ" },
              { value: "z", label: "Z normal / XY" },
            ],
          },
          {
            type: "radio-group",
            id: "slice:plane:mode",
            label: "Mode",
            value: mode,
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onValueChange: (nextMode) =>
              ctx.run({
                id: "viewport.set-slice-mode",
                mode: nextMode as "single" | "slab" | "all_layers",
              }),
            items: [
              { value: "single", label: "Single" },
              { value: "slab", label: "Slab" },
              { value: "all_layers", label: "All layers" },
            ],
          },
          {
            type: "slider",
            id: "slice:plane:position",
            label: "Position",
            value: position,
            min: 0,
            max: 100,
            step: 0.5,
            unit: "%",
            disabled: slice.disabled,
            disabledReason: slice.reason,
            onValueChange: (positionPercent) => ctx.run({ id: "viewport.set-slice-position", positionPercent }),
          },
        ],
      },
    ],
  };
}

function buildSelectedDisplayGroup(ctx: RibbonBuildContext): RibbonGroup {
  const selected = canUseSelected(ctx);
  const selectedTextureDisabledReason = selected.reason
    ?? (ctx.quantityShaderVisible
      ? "Turn off global Quantity overlay to edit per-object magnetic texture visibility"
      : !ctx.magneticTextureVisible
        ? "Enable global Texture first"
        : null);
  const selectedTextureDisabled = Boolean(selectedTextureDisabledReason);
  const selectedOpacity = ctx.selectedObjectOpacity ?? ctx.meshOpacity ?? 100;
  return {
    id: "view-selected-display",
    title: "Selected Display",
    subtitle: ctx.selectedObjectId ? "Per object" : "No selection",
    tone: "selection",
    actions: [
      {
        id: "view-selected-texture",
        icon: <Sparkles size={20} />,
        label: "Texture",
        tooltip: selectedTextureDisabledReason ?? "Override magnetic texture visibility for the selected object",
        disabled: selectedTextureDisabled,
        active: ctx.selectedObjectTextureVisible ?? ctx.magneticTextureVisible,
        iconColor: "text-teal-300",
        menu: [
          {
            type: "label",
            id: "selected-texture:header",
            label: "Selected texture",
            badge:
              ctx.selectedObjectTextureVisible == null
                ? "inherit"
                : ctx.selectedObjectTextureVisible
                  ? "on"
                  : "off",
          },
          {
            type: "status",
            id: "selected-texture:state",
            label: "Global texture",
            value: ctx.magneticTextureVisible ? "Enabled" : "Disabled",
          },
          {
            type: "checkbox",
            id: "selected-texture:visible",
            label: "Texture on/off",
            checked: ctx.selectedObjectTextureVisible ?? ctx.magneticTextureVisible,
            disabled: selectedTextureDisabled,
            disabledReason: selectedTextureDisabledReason,
            onCheckedChange: (visible) => ctx.run({ id: "viewport.toggle-selected-texture", visible }),
          },
        ],
      },
      {
        id: "view-selected-render",
        icon: <BoxSelect size={20} />,
        label: "Render",
        tooltip: selected.reason ?? "Edit selected object display",
        disabled: selected.disabled,
        iconColor: "text-amber-300",
        menu: [
          { type: "label", id: "selected:header", label: "Selected object", badge: ctx.selectedObjectId ?? "none" },
          { type: "status", id: "selected:state", label: "State", value: ctx.selectedObjectId ? "inherited" : "empty" },
          {
            type: "radio-group",
            id: "selected:render-mode",
            label: "Render mode",
            value: ctx.selectedObjectRenderMode ?? "inherit",
            disabled: selected.disabled,
            disabledReason: selected.reason,
            onValueChange: (renderMode) =>
              ctx.run({
                id: "viewport.set-selected-render-mode",
                renderMode: renderMode as ViewportMeshRenderMode | "inherit",
              }),
            items: [
              { value: "inherit", label: "Inherit global" },
              { value: "surface", label: "Shaded" },
              { value: "wireframe", label: "Wireframe" },
              { value: "surface+edges", label: "Shaded + wireframe" },
              { value: "points", label: "Points" },
            ],
          },
          { type: "item", id: "selected:clear", label: "Clear per-object overrides", disabled: selected.disabled, disabledReason: selected.reason, action: () => ctx.run({ id: "viewport.clear-selected-display-overrides" }) },
        ],
      },
      {
        id: "view-selected-clip",
        icon: <Scissors size={20} />,
        label: "Clip",
        tooltip: selected.reason ?? "Clip selected object",
        disabled: selected.disabled,
        iconColor: "text-orange-300",
        menu: [
          { type: "label", id: "selected-clip:header", label: "Selected clip", badge: "planned" },
          { type: "status", id: "selected-clip:runtime", label: "Runtime", value: "Runtime currently supports one active clip axis", tone: "warning" },
        ],
      },
      {
        id: "view-selected-opacity",
        icon: <Blend size={20} />,
        label: "Opacity",
        tooltip: selected.reason ?? "Set selected opacity",
        disabled: selected.disabled,
        iconColor: "text-lime-300",
        menu: [
          {
            type: "slider",
            id: "selected-opacity:slider",
            label: "Opacity",
            value: selectedOpacity,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            disabled: selected.disabled,
            disabledReason: selected.reason,
            onValueChange: (opacity) => ctx.run({ id: "viewport.set-selected-opacity", opacity }),
          },
          { type: "item", id: "selected-opacity:100", label: "100%", action: () => ctx.run({ id: "viewport.set-selected-opacity", opacity: 100 }) },
          { type: "item", id: "selected-opacity:70", label: "70%", action: () => ctx.run({ id: "viewport.set-selected-opacity", opacity: 70 }) },
          { type: "item", id: "selected-opacity:35", label: "35%", action: () => ctx.run({ id: "viewport.set-selected-opacity", opacity: 35 }) },
          { type: "item", id: "selected-opacity:15", label: "Ghost 15%", action: () => ctx.run({ id: "viewport.set-selected-opacity", opacity: 15 }) },
        ],
      },
    ],
  };
}

function buildManipulateGroup(ctx: RibbonBuildContext): RibbonGroup {
  const global = canUse3D(ctx);
  const authoringReason = ctx.builderEnabled ? null : "Requires Geometry Authoring / explicit topology capability";
  return {
    id: "view-manipulate",
    title: "Manipulate",
    subtitle: "Camera and gizmo",
    tone: "authoring",
    actions: [
      {
        id: "view-control-mode",
        icon: <MousePointer2 size={20} />,
        label: "Control",
        tooltip: "Choose camera, selection, or manipulation mode",
        disabled: global.disabled,
        iconColor: "text-violet-300",
        menu: [
          {
            type: "radio-group",
            id: "control:mode",
            label: "Control mode",
            value: ctx.activeTransformScope ? "manipulate" : "camera",
            onValueChange: (mode) => ctx.run({ id: "viewport.set-control-mode", mode: mode as "camera" | "select" | "manipulate" }),
            items: [
              { value: "camera", label: "Camera navigation" },
              { value: "select", label: "Select object", disabled: !ctx.builderEnabled, disabledReason: authoringReason },
              { value: "manipulate", label: "Manipulate selected", disabled: !ctx.builderEnabled || !ctx.selectedObjectId, disabledReason: !ctx.selectedObjectId ? "Requires selected object" : authoringReason },
            ],
          },
        ],
      },
      {
        id: "view-transform-gizmo",
        icon: <Move3D size={20} />,
        label: "Gizmo",
        tooltip: "Transform selected object or texture",
        disabled: global.disabled,
        iconColor: "text-fuchsia-300",
        menu: [
          {
            type: "radio-group",
            id: "gizmo:scope",
            label: "Scope",
            value: ctx.activeTransformScope ?? "camera",
            onValueChange: (scope) => ctx.run({ id: "viewport.set-transform-scope", scope: scope as "camera" | "object" | "texture" }),
            items: [
              { value: "object", label: "Object transform", disabled: !ctx.selectedObjectId, disabledReason: "Requires selected object" },
              { value: "texture", label: "Texture transform", disabled: !ctx.selectedObjectId, disabledReason: "Requires selected object" },
              { value: "camera", label: "Camera only / no gizmo" },
            ],
          },
          {
            type: "radio-group",
            id: "gizmo:tool",
            label: "Tool",
            value: "move",
            onValueChange: (tool) => ctx.run({ id: "viewport.set-transform-tool", tool: tool as "select" | "move" | "rotate" | "scale" }),
            items: [
              { value: "move", label: "Move / Translate" },
              { value: "rotate", label: "Rotate" },
              { value: "scale", label: "Scale" },
            ],
          },
          { type: "separator", id: "gizmo:s0" },
          { type: "item", id: "gizmo:focus", label: "Focus selected", disabled: !ctx.can({ id: "viewport.focus-selected-object" }), action: () => ctx.run({ id: "viewport.focus-selected-object" }) },
        ],
      },
    ],
  };
}

function buildSnapshotExportGroup(ctx: RibbonBuildContext): RibbonGroup {
  return {
    id: "view-snapshot-export",
    title: "Snapshot / Export",
    subtitle: "Output",
    tone: "sync",
    actions: [
      {
        id: "view-snapshot",
        icon: <Camera size={20} />,
        label: "Snapshot",
        tooltip: "Capture current viewport",
        disabled: !ctx.can({ id: "viewport.capture" }),
        iconColor: "text-rose-300",
        menu: [
          { type: "item", id: "snapshot:current", label: "Capture current viewport", action: () => ctx.run({ id: "viewport.capture" }) },
          { type: "item", id: "snapshot:transparent", label: "Capture transparent background", disabled: true, disabledReason: "Transparent capture options are staged for viewport capture presets" },
          { type: "item", id: "snapshot:overlays", label: "Capture with overlays", action: () => ctx.run({ id: "viewport.capture", overlays: true }) },
          { type: "item", id: "snapshot:no-overlays", label: "Capture without overlays", disabled: true, disabledReason: "Overlay capture toggle is staged for capture options" },
        ],
      },
      {
        id: "view-export",
        icon: <Download size={20} />,
        label: "Export",
        tooltip: "Export image, state, or active data",
        iconColor: "text-teal-300",
        menu: [
          { type: "item", id: "export:image", label: "Export viewport image", disabled: !ctx.can({ id: "viewport.export-image" }), action: () => ctx.run({ id: "viewport.export-image" }) },
          { type: "item", id: "export:state", label: "Export viewport state", disabled: !ctx.can({ id: "viewport.export-state" }), action: () => ctx.run({ id: "viewport.export-state" }) },
          { type: "item", id: "export:preset", label: "Save as visualization preset", disabled: !ctx.can({ id: "visualization.create-preset" }), action: () => ctx.run({ id: "visualization.create-preset" }) },
        ],
      },
    ],
  };
}

function buildDisplayGroup(ctx: RibbonBuildContext): RibbonGroup {
  const objectView = canUseObjectView(ctx);
  const isolateDisabledReason = objectView.reason ?? (!ctx.selectedObjectId ? "Select object to isolate it" : null);
  const isolateDisabled = Boolean(isolateDisabledReason);
  return {
    id: "view-display",
    title: "Display",
    subtitle: "Mode, camera, panels",
    tone: "neutral",
    actions: [
      {
        id: "view-mode-menu",
        icon: <Monitor size={20} />,
        label: "Mode",
        tooltip: "Switch viewport surface",
        iconColor: "text-indigo-300",
        menu: [
          {
            type: "radio-group",
            id: "view-mode:radio",
            value: ctx.viewMode ?? "3D",
            onValueChange: (mode) => ctx.run({ id: "viewport.set-mode", mode }),
            items: [
              { value: "3D", label: "3D" },
              { value: "2D", label: "2D" },
              { value: "Mesh", label: "Mesh" },
              { value: "Analyze", label: "Analyze / Results" },
            ],
          },
          { type: "item", id: "view-mode:preset", label: "Create 3D visualization preset", action: () => ctx.run({ id: "visualization.create-preset" }) },
        ],
      },
      {
        id: "view-camera",
        icon: <Camera size={20} />,
        label: "Camera",
        tooltip: "Camera framing and navigation",
        iconColor: "text-sky-300",
        menu: [
          { type: "item", id: "camera:focus", label: "Focus selected", disabled: !ctx.can({ id: "viewport.focus-selected-object" }), action: () => ctx.run({ id: "viewport.focus-selected-object" }) },
          { type: "item", id: "camera:frame-all", label: "Frame all", disabled: !ctx.can({ id: "builder.frame-all" }), action: () => ctx.run({ id: "builder.frame-all" }) },
          { type: "item", id: "camera:trackball", label: "Trackball navigation", disabled: true, disabledReason: "Navigation profile persistence is pending viewport settings state" },
          { type: "item", id: "camera:orbit", label: "Orbit navigation", disabled: true, disabledReason: "Navigation profile persistence is pending viewport settings state" },
        ],
      },
      {
        id: "view-object-context",
        icon: <Layers3 size={20} />,
        label: "Context",
        tooltip: objectView.reason ?? "Show selected object in scene context",
        active: ctx.objectViewMode === "context",
        disabled: objectView.disabled,
        iconColor: "text-cyan-300",
        action: () => ctx.run({ id: "viewport.set-object-view", mode: "context" }),
      },
      {
        id: "view-object-isolate",
        icon: <BoxSelect size={20} />,
        label: "Isolate",
        tooltip: isolateDisabledReason ?? "Show only the selected object",
        active: ctx.objectViewMode === "isolate",
        disabled: isolateDisabled,
        iconColor: "text-amber-300",
        action: () => ctx.run({ id: "viewport.set-object-view", mode: "isolate" }),
      },
      {
        id: "view-panels",
        icon: <PanelRight size={20} />,
        label: "Panels",
        tooltip: "Toggle inspector, legend, and diagnostics panels",
        active: ctx.sidebarVisible || ctx.viewportLegendVisible,
        iconColor: "text-muted-foreground",
        menu: [
          { type: "checkbox", id: "panels:right", label: "Right inspector", checked: ctx.sidebarVisible, onCheckedChange: () => ctx.run({ id: "viewport.toggle-sidebar" }) },
          { type: "checkbox", id: "panels:legend", label: "Legend", checked: ctx.viewportLegendVisible, onCheckedChange: () => ctx.run({ id: "viewport.toggle-legend" }) },
          { type: "checkbox", id: "panels:scene-info", label: "Scene info", checked: false, disabled: true, disabledReason: "Scene info panel is diagnostic-only in the current viewport", onCheckedChange: () => undefined },
          { type: "checkbox", id: "panels:diagnostics", label: "Diagnostics", checked: false, disabled: true, disabledReason: "Diagnostics are controlled by frontend diagnostic flags", onCheckedChange: () => undefined },
        ],
      },
      {
        id: "view-dimension-frame",
        icon: <Ruler size={20} />,
        label: "Frame",
        tooltip: "Toggle dynamic dimension frame and axis scale",
        active: ctx.universeWireframeVisible,
        iconColor: "text-emerald-300",
        action: () => ctx.run({ id: "viewport.toggle-universe-wireframe" }),
      },
      {
        id: "view-axes",
        icon: <Ruler size={20} />,
        label: "Axes",
        tooltip: "Axes and scale display",
        iconColor: "text-emerald-300",
        menu: [
          {
            type: "radio-group",
            id: "axes:scope",
            label: "Axes scope",
            value: ctx.viewportAxesScope,
            disabled: !ctx.can({ id: "viewport.set-axes-scope", scope: "universe" }),
            onValueChange: (scope) => ctx.run({ id: "viewport.set-axes-scope", scope: scope as "universe" | "object" }),
            items: [
              { value: "universe", label: "Universe scale" },
              { value: "object", label: "Object scale" },
            ],
          },
          { type: "checkbox", id: "axes:wireframe", label: "Dimension frame", checked: ctx.universeWireframeVisible, onCheckedChange: () => ctx.run({ id: "viewport.toggle-universe-wireframe" }) },
        ],
      },
      {
        id: "view-topography",
        icon: <Sparkles size={20} />,
        label: "Topography",
        tooltip: "Structured-grid topography",
        disabled: ctx.isFemBackend,
        iconColor: "text-amber-300",
        menu: [
          { type: "label", id: "topography:header", label: "Topography", badge: ctx.isFemBackend ? "unavailable" : "FDM" },
          { type: "status", id: "topography:status", label: "Status", value: ctx.isFemBackend ? "Disabled for FEM explicit topology" : "Controlled by structured-grid renderer" },
        ],
      },
    ],
  };
}

export function buildViewRibbonGroups(ctx: RibbonBuildContext): RibbonGroup[] {
  return [
    buildGlobalDisplayGroup(ctx),
    buildSlice2DGroup(ctx),
    buildSelectedDisplayGroup(ctx),
    buildManipulateGroup(ctx),
    buildSnapshotExportGroup(ctx),
    buildDisplayGroup(ctx),
  ];
}

registerRibbonContribution({
  tab: "view",
  priority: 0,
  buildGroups: buildViewRibbonGroups,
});
