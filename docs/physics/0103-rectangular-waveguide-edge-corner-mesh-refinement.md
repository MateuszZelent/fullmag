# Rectangular waveguide edge and corner mesh refinement

## 1. Physical / numerical statement

This note defines a **discretization-only** refinement mode for rectangular
ferromagnetic waveguides represented as `Box` geometries in the FEM shared-domain
mesh pipeline.

The goal is to make the solver mesh:
- denser near the **in-plane edges** of the rectangular ferromagnet,
- densest near the **in-plane corners**,
- coarser in the object center,

without changing physics, material parameters, regions, airbox semantics, or
observable definitions.

This is not a new energy term or boundary condition. It is a controlled spatial
mesh-size policy for geometries where edge-localized magnetization structure can
matter more than the central bulk.

## 2. Public semantics

V1 introduces four per-object mesh controls:

- `edge_hmax`
- `edge_thickness`
- `corner_hmax`
- `corner_extent`

All values are in SI metres.

Interpretation:
- `edge_hmax`: target element size inside four in-plane edge bands.
- `edge_thickness`: inward width of each edge band from the rectangular boundary.
- `corner_hmax`: target element size inside four in-plane corner zones.
- `corner_extent`: in-plane extent of each corner zone along both lateral axes.

The two largest `Box` dimensions define the in-plane axes. The smallest `Box`
dimension is treated as thickness. Refinement spans the full thickness; it does
not create separate top/bottom surface shells.

## 3. Scope and limits

V1 supports only:
- `Box`
- `Translate(Box)`
- FEM shared-domain meshing with component-aware volume identity

V1 does not support:
- cylinders, ellipses, STL imports, boolean CSG, or curved waveguides
- automatic projection to arbitrary polygonal perimeter refinement
- independent default/global study-object edge/corner policies

## 4. Validation rules

- `edge_hmax` requires `edge_thickness`
- `corner_hmax` requires `corner_extent`
- `corner_hmax <= edge_hmax` when both are present
- `edge_thickness < 0.5 * min(in_plane_dimensions)`
- `corner_extent < 0.5 * min(in_plane_dimensions)`
- edge/corner refinement cannot be combined with `interface_hmax` or `interface_thickness`

`transition_distance` remains a separate object-to-air grading control and is
not part of the edge/corner contract.

## 5. FEM interpretation

The refinement is lowered into local background mesh-size fields restricted to
the ferromagnet volume:
- four edge-aligned sub-boxes
- four corner sub-boxes

The active element size is the minimum of:
- the bulk object target,
- edge sub-box targets,
- corner sub-box targets,
- any other non-conflicting active lower-size constraints

The mesh growth back toward the object center remains governed by the existing
global/object growth-rate semantics.

## 6. FDM interpretation

None. This feature is FEM-only and has no FDM discretization meaning.

## 7. UI / script / provenance impact

- Python DSL exposes the new kwargs directly on `body.mesh(...)`
- script export and builder round-trip preserve the four fields verbatim
- UI object-mesh authoring exposes the controls only for `Box` objects
- mesh build reports may expose resolved edge/corner targets per object

## 8. Validation plan

- DSL round-trip tests for load -> export -> rewrite
- field-planner tests for 4 edge + 4 corner regions
- rejection tests for geometry mismatch and interface-shell conflict
- UI/session tests for builder/options round-trip

## 9. Deferred work

- support for curved or swept waveguides
- support for imported CAD/STL objects with robust perimeter extraction
- separate edge/corner transition-distance semantics
- study-level defaults for perimeter refinement
