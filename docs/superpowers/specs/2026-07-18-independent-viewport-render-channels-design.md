# Independent Viewport Render Channels Design

**Status:** Accepted for implementation

**Date:** 2026-07-18

**Scope:** Control Room v2 visualization state, target resolution, and unified 3D viewport rendering

## Problem

The current renderer does not preserve the semantic independence already implied
by the visualization resource:

- wireframe, points, vectors, and bounds can derive their effective opacity from
  surface opacity;
- authored and realized region diagnostics can render filled shells using the
  physical target's surface visibility, color, and opacity;
- the diagnostic shell can therefore look like a stale second field shader and
  obscure a current component or colormap;
- target settings omit effective point and bounds opacity even though the v2
  resource stores opacity for those layers.

## Canonical render channels

Every renderable target is planned as independent channels:

| Channel | Visibility owner | Opacity owner | Data/material owner |
|---|---|---|---|
| Surface | `display.surface.visible` | `display.surface.opacity` | physical scalar/solid surface material |
| Wireframe | `display.wireframe.visible` | `display.wireframe.opacity` | topology feature-edge material |
| Points | `display.points.visible` | `display.points.opacity` | topology point material |
| Vectors | `display.vectors.visible` | `style.vector_alpha` | physical vector glyph material |
| Bounds | `display.bounds.visible` | `display.bounds.opacity` | bounds diagnostic material |
| Primitive fallback | `display.primitives.visible` | primitive layer opacity | authored geometry fallback only |
| Region diagnostics | viewport-local diagnostic state | diagnostic policy | authored/realized region geometry only |
| Selection | selection state | selection policy | interaction highlight only |

No channel opacity may be multiplied by another channel's opacity. A material
profile may apply a channel-local constant, but it must not read another
channel's target setting.

## Visualization resource contract

HTTP v2 remains the source of truth. Target override writes use nested layer
patches. The legacy flat `display.opacity` field remains read-only compatibility
input; new writes use `display.surface.opacity`.

Resolved target settings expose surface, wireframe, point, bounds, and vector
opacity independently. The frontend domain model uses explicit names:

- `surfaceOpacityPercent`;
- `wireframeOpacityPercent`;
- `pointOpacityPercent`;
- `boundsOpacityPercent`;
- `vectorAlphaPercent`.

OpenAPI source, generated types, the handwritten visualization controller, and
all consumers move together. No component creates an alternate opacity model.

## Region visualization and diagnostics

Physical visualization of a region is permitted only through the current mesh
manifest's `mesh_part_ids` and the normal scalar/vector target path. It inherits
its owning object's effective visualization until an explicit sparse region
override exists.

Region diagnostics are not physical visualization. They never consume target
quantity, component, colormap, surface color, surface visibility, or target
opacity. Authored and realized diagnostics are outline-only. The diagnostic
state is viewport-local:

```ts
interface RegionDiagnosticOverlayState {
  visible: boolean;
  source: "auto" | "authored" | "realized" | "both";
}
```

It starts with `visible: false`. Selecting a region does not enable it. `auto`
selects realized outlines when current mesh-backed regions exist and authored
outlines otherwise. Diagnostic picking remains available only while diagnostics
are visible.

## Primitive fallback

Primitive fallback represents authored geometry before a current mesh carrier
exists. It is excluded once current mesh-backed geometry exists for the object.
It never receives field buffers, scalar colors, quantity selection, or vector
glyphs. In Geometry context the Inspector exposes an explicit `Primitive`
toggle while topology is absent or stale. Its monochrome color and opacity are
viewport-local target preferences, independent from the physical surface
shader, and its geometry is bounded by the authored object's resolved bounds.

## Shared render plan

A pure target render-plan resolver converts effective target settings and
capability/carrier availability into channel plans. FEM mesh parts, fallback
topology, FDM cuboids, and airbox layers consume the same opacity and visibility
semantics. Components remain responsible for GPU resource ownership, not policy.

Surface style changes update scalar/material inputs without changing topology
keys. Quantity, component, projection, palette, range, and surface opacity may
dirty the surface material path, but never rebuild topology geometry.

## Compatibility

- Existing nested per-layer overrides retain their meaning.
- Existing flat `display.opacity` is accepted as a legacy surface-opacity input.
- New writes never emit flat `display.opacity`.
- Missing point or bounds opacity resolves from the corresponding global layer
  state and then the existing default.
- Region diagnostics are viewport preference, not a persisted simulation or
  ProblemIR value.

## Verification

Completion requires:

1. API tests proving independent resolved opacities and legacy surface-opacity
   compatibility.
2. Controller tests proving nested writes and independent target resolution.
3. Pure render-plan tests proving that no opacity depends on surface opacity.
4. Region model tests proving outline-only diagnostics without target settings.
5. FEM, FDM, fallback, airbox, and primitive layer tests consuming the plan.
6. A regression test proving component/colormap updates do not change topology
   identity.
7. Full Control Room typecheck, zero-warning lint, and tests.
8. Browser smoke proving a visible canvas, non-lost WebGL context, non-zero
   drawing buffer, component-color update, independent opacity, and no filled
   region diagnostic shell.
