# Rectangular waveguide edge and corner mesh refinement

## 1. Physical / numerical statement

This note defines a **discretization-only** refinement mode for ferromagnetic
waveguides in the FEM shared-domain mesh pipeline.

The goal is to make the solver mesh:
- denser near the **in-plane edges** of the rectangular ferromagnet,
- densest near the **in-plane corners**,
- coarser in the object center,

without changing physics, material parameters, regions, airbox semantics, or
observable definitions.

Production-readiness criteria for rectangular edge/corner refinement are
defined in `docs/physics/0105-fem-meshing-production-acceptance.md`.

This is not a new energy term or boundary condition. It is a controlled spatial
mesh-size policy for geometries where edge-localized magnetization structure can
matter more than the central bulk.

## 2. Public semantics

The per-object mesh controls are:

- `edge_hmax`
- `edge_thickness`
- `corner_hmax`
- `corner_extent`
- `corner_transition_distance`

All values are in SI metres.

Interpretation:
- `edge_hmax`: target element size inside four in-plane edge bands.
- `edge_thickness`: inward width of each edge band from the rectangular boundary.
- `corner_hmax`: target element size inside four in-plane corner zones.
- `corner_extent`: in-plane extent of each corner zone along both lateral axes.
- `corner_transition_distance`: optional air-side transition distance from
  component boundary endpoints back toward the far-field airbox target.

For `Box` and `Translate(Box)`, the two largest dimensions define the in-plane
axes. The smallest dimension is treated as thickness. Refinement spans the full
thickness; it does not create separate top/bottom surface shells.

For non-box component-aware geometries, edge and corner controls lower to
distance fields from recovered component boundary curves and curve endpoints.
Those fields intentionally cross the conformal object-air interface, so they
can refine the neighboring airbox around sharp magnetic edges.

## 3. Scope and limits

V1 supports:
- `Box`
- `Translate(Box)`
- FEM shared-domain meshing with component-aware volume identity

V2 additionally supports component-aware edge/corner distance fields for
non-box geometries when Gmsh recovers boundary curves and endpoints.

This note does not define:
- automatic projection to arbitrary polygonal perimeter refinement
- independent default/global study-object edge/corner policies

## 4. Validation rules

- `edge_hmax` requires `edge_thickness`
- `corner_hmax` requires `corner_extent`
- `corner_hmax <= edge_hmax` when both are present
- `corner_transition_distance` requires `corner_hmax` and `corner_extent`
- `edge_thickness < 0.5 * min(in_plane_dimensions)`
- `corner_extent < 0.5 * min(in_plane_dimensions)`

`transition_distance` remains a separate surface object-to-air grading control.
It is not inherited by corner endpoint fields. Use
`corner_transition_distance` when a corner-specific air plume is intended.

## 5. FEM interpretation

For rectangular boxes, refinement is lowered into local background mesh-size
fields restricted to the ferromagnet volume:
- four edge-aligned sub-boxes
- four corner sub-boxes

For non-box component-aware geometries, refinement is lowered into unrestricted
distance fields from component boundary curves and curve endpoints. These fields
are allowed to refine the airbox side of the conformal interface.

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

- Python DSL exposes the kwargs directly on `body.mesh(...)`
- script export and builder round-trip preserve the fields verbatim
- UI object-mesh authoring may expose box-local controls separately from
  component-boundary controls
- mesh build reports may expose resolved edge/corner targets per object

## 8. Validation plan

- DSL round-trip tests for load -> export -> rewrite
- field-planner tests for 4 edge + 4 corner regions
- rejection tests for geometry mismatch and interface-shell conflict
- UI/session tests for builder/options round-trip

## 9. Deferred work

- support for curved or swept waveguides
- support for imported CAD/STL objects with robust perimeter extraction when
  component boundary identity is unavailable
- separate edge transition-distance semantics
- study-level defaults for perimeter refinement
