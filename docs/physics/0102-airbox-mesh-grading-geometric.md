# Airbox mesh grading: geometric vs linear

- Status: draft
- Last updated: 2026-06-02
- Related specs: `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`
- Related code:
  - `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py`
  - `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`
  - `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
  - `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`
  - `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`

Production-readiness criteria for this grading contract are defined in
`docs/physics/0105-fem-meshing-production-acceptance.md`.

## 1. Problem statement

The current Fullmag airbox meshing uses **linear interpolation** for element size as a function
of distance from the magnetic body interface. This is inefficient and inconsistent with
established FEM practice (e.g., COMSOL).

The correct approach is **geometric growth**: element size increases by a fixed ratio (growth
rate) with each successive layer from the interface.

## 2. Physical motivation

### 2.1 Magnetostatic potential decay

In the air region surrounding a finite magnetic body, the scalar magnetostatic potential φ
satisfies Laplace's equation:

$$
\nabla^2 \phi = 0 \quad \text{in air region}
$$

The solution decays with distance as a multipole expansion:

| Source character | Potential decay | Field decay (∇φ) |
|------------------|-----------------|------------------|
| Monopole         | ~1/r            | ~1/r²            |
| Dipole           | ~1/r²           | ~1/r³            |
| Quadrupole       | ~1/r³           | ~1/r⁴            |

For typical magnetic bodies, the dominant far-field term is dipolar (~1/r²).

### 2.2 Discretization error scaling

For polynomial FEM with order p, the discretization error scales as:

$$
\varepsilon \sim h^{p+1}
$$

where h is element size. To maintain uniform relative error across the domain:

- Where gradients are large (near interface): small h
- Where gradients are small (far field): large h acceptable

### 2.3 Optimal mesh grading

For efficient meshes, element size should grow proportionally to the characteristic length
scale of the solution. For dipolar decay (~1/r³ gradients), allowing h ~ r gives acceptable
accuracy while minimizing element count.

The ideal local geometric growth model:

$$
h(r) = h_0 \cdot g^{r/h_0}
$$

where:
- h₀ = interface element size
- g = growth rate (typically 1.2–1.5)
- r = distance from interface

For a bounded rectangular airbox this local model is not enough by itself: if
`h0` is very small or the airbox is shallow in one direction, the field may not
reach the far-field target at the outer boundary. Fullmag therefore uses a
boundary-normalized geometric profile for airbox and transition fields:

$$
s = \mathrm{clamp}\left(\frac{r-r_\min}{r_\max-r_\min}, 0, 1\right)
$$

$$
\psi(s,g) =
\begin{cases}
s, & g \le 1 \\
\frac{\log(1 + (g - 1)s)}{\log(g)}, & g > 1
\end{cases}
$$

$$
h(r) = h_\min \exp\left(\log\left(\frac{h_\max}{h_\min}\right)\psi(s,g)\right)
$$

This keeps the near-object region smooth, preserves a geometric size law, and
guarantees `h(r_max) = hmax` for the controlled outer boundary/corner distance.

## 3. Current implementation status

Geometric grading is implemented through shared helpers used by the GEO/OCC
airbox paths and by semantic transition fields. The implementation must keep
all airbox paths on the same grading contract:

- `geometric`: boundary-normalized exponential growth reaching `airbox_hmax`
  at the relevant outer airbox boundary/corner span
- `linear`: legacy `Threshold` interpolation
- `airbox_hmin`: near-object size target, not gradient distance
- `DistMax`: distance to the relevant outer airbox boundary/corner or explicit
  transition span
- `airbox_growth_rate` / `transition_growth`: curvature of the normalized
  geometric ramp, not a replacement for the outer `hmax` target
- `edge_transition_distance`: optional boundary-curve grading span, distinct from
  the surface `transition_distance`
- `corner_transition_distance`: optional endpoint/corner grading span, distinct
  from both the surface and edge transition spans
- `transition_distance="airbox_boundary"`: resolve the surface grading span
  from the magnetic-object bounds to the explicit or effective airbox boundary
- `edge_transition_distance="airbox_boundary"` and
  `corner_transition_distance="airbox_boundary"`: resolve perimeter plume spans
  from the object edge/endpoint shell to the relevant side/corner airbox span

COMSOL-like object size controls are interpreted as follows:

- `curvature_factor`: a dimensionless bound `h <= factor * R` on curved
  object surfaces where `R` is the sampled local radius of curvature. Fullmag
  still enables Gmsh's native curvature sizing, but the supplemental
  surface-near field is restricted to surfaces with nonzero sampled curvature;
  flat faces must not be refined solely because this control is active.
- `narrow_region_resolution`: a dimensionless strength mapped to an element
  count across body-local narrow regions. The current FEM realization combines
  a distance-to-magnetic-body-surface estimate with a component-volume
  bounding-box narrow-span constraint `h <= min_span / n_resolve`, both
  restricted to magnetic volumes. It does not refine airbox gaps from
  distance-to-body; airbox-side edge/corner plumes are controlled separately by
  `edge_transition_distance` and `corner_transition_distance`.

## 3.1 Legacy implementation (problematic)

File: `_gmsh_airbox.py`, lines 178-187:

```python
gmsh.model.mesh.field.add("Threshold", 2)
gmsh.model.mesh.field.setNumber(2, "InField", 1)  # Distance field
gmsh.model.mesh.field.setNumber(2, "SizeMin", h_inner)
gmsh.model.mesh.field.setNumber(2, "SizeMax", h_outer)
gmsh.model.mesh.field.setNumber(2, "DistMin", 0.0)
gmsh.model.mesh.field.setNumber(2, "DistMax", max(d_outer, hmax))
```

This creates **linear interpolation**:

$$
h(r) = h_{\min} + (h_{\max} - h_{\min}) \cdot \frac{r}{d_{\max}}
$$

Problems:
1. Produces too many elements near the outer boundary (linear is too slow)
2. Or if d_outer is too small, produces badly-graded jump to airbox_hmax

## 4. Correct implementation

### 4.1 Gmsh MathEval field

Replace the Threshold field with a MathEval field that implements normalized
geometric growth:

```python
# Distance field (unchanged)
f_dist = gmsh.model.mesh.field.add("Distance")
gmsh.model.mesh.field.setNumbers(f_dist, "SurfacesList", interface_surfaces)

# Geometric growth via MathEval
f_growth = gmsh.model.mesh.field.add("MathEval")
growth_rate = 1.3  # standard COMSOL default
# s = clamp(distance / dist_max, 0, 1)
# psi(s, g) = log(1 + (g - 1) * s) / log(g)
# h(r) = h_inner * exp(log(h_outer / h_inner) * psi)
gmsh.model.mesh.field.setString(
    f_growth, "F",
    f"{h_inner} * exp(log({h_outer} / {h_inner}) * psi)"
)

# Optional cap at airbox_hmax
f_cap = gmsh.model.mesh.field.add("Min")
gmsh.model.mesh.field.setNumbers(f_cap, "FieldsList", [f_growth, f_const_hmax])
```

### 4.2 Parameter choices

| Parameter    | Description                          | Default | Range     |
|--------------|--------------------------------------|---------|-----------|
| growth_rate  | h_{n+1} / h_n ratio                 | 1.3     | 1.1–2.0   |
| h_inner      | Element size at magnetic interface   | hmax    | > 0       |
| airbox_hmax  | Maximum element size in far field    | 10×hmax | > h_inner |

`transition_growth` uses the same ramp curvature for per-object transition
fields. If omitted, the transition still uses geometric interpolation from
`SizeMin` to `SizeMax`; it simply uses the default neutral ramp shape.

### 4.3 Conformal shared-domain constraint

For FEM Poisson-airbox demagnetics, the magnetic body and airbox are meshed as
one conforming shared domain. The airbox must therefore reuse the magnetic
surface triangulation on the body-air interface. `airbox_hmax` is a far-field
target; it must not coarsen the interface below the per-object magnetic target,
and it cannot reduce the number of interface vertices already required by the
magnetic body.

Thin-film bodies amplify this effect. If a 2 nm film has a large in-plane
surface and requests an 8 nm magnetic surface scale, the top and bottom
interface surfaces alone require O(area / h^2) triangles. A very thin airbox in
z also leaves little distance for grading to relax from the interface scale to
`airbox_hmax`.

### 4.4 Boundary-aware gradient length

The grading length must cover the full airbox region that the field is expected
to control. For rectangular airboxes, using only the largest axis gap can leave
far corners outside the intended transition span. The fallback `DistMax` should
therefore be conservative with respect to the farthest outer-boundary point from
the magnetic-object bounds.

Public scripts may request this behavior explicitly with
`transition_distance="airbox_boundary"`. The planner resolves the token during
shared-domain mesh planning, where both object bounds and airbox bounds are
available. For rectangular airboxes:

- the surface transition field resolves `DistMax` to the largest face-normal
  clearance from the object bounds to the airbox bounds;
- the edge transition field resolves `DistMax` to the same side clearance
  unless explicitly overridden, so air next to object edges grows to the
  far-field airbox target instead of stopping in a short local halo;
- the corner transition field resolves `DistMax` to the Euclidean clearance
  from the object bounds to the farthest airbox corner, so diagonal/corner
  regions remain covered by the same gradient contract.

The token is preserved as requested intent in `runtime_metadata.mesh_workflow`.
The resolved numeric `DistMax` lives in the generated size-field descriptors and
is used by Gmsh. Without the token, the planner keeps the existing explicit
numeric behavior or the local `3 * h_body` transition default. If the token is
requested without rectangular airbox bounds, the planner must raise an error
instead of silently inventing an airbox boundary.

Mesh validation must also reject elements below the FEM topology determinant
floor before exporting `MeshIR` to the solver. The Python meshing pipeline uses
the same determinant threshold as the Rust FEM topology builder
(`|det J| <= 1e-30 m^3`, equivalently `|V| <= 1e-30 / 6 m^3`) so Delaunay/HXT
slivers trigger the meshing retry path instead of failing later during initial
state diagnostics.

For explicit rectangular airboxes, the `airbox_boundary` transition uses a
per-side normalized rectangular ramp instead of one Euclidean distance. For each
object-to-airbox face clearance `g_i`, the ramp is
`clamp((delta_i - DistMin) / (g_i - DistMin), 0, 1)`, and the field uses the
maximum over the six side ramps. This keeps the requested near-interface shell
at the object while allowing the field to reach `h_outer` on every airbox face,
including thin `z` clearances. Other independent refinement fields may still be
combined outside this airbox transition with the normal global `Min` stack.

### 4.5 Air-side edge and corner constraints

For sharp or thin magnetic bodies, surface distance alone is not enough to
guarantee air refinement around high-curvature perimeter features. The airbox
field stack may therefore add unrestricted distance thresholds from component
boundary curves and their endpoints. These fields intentionally cross the
conformal component-air interface: restricting them to the magnetic volume would
leave the neighboring air coarse at exactly the edge/corner locations where the
demag potential changes fastest.

Boundary-curve and endpoint fields may use transition spans that differ from the
surface `transition_distance`. A long surface transition is useful for smooth
object-to-air grading, but applying that same span to all perimeter fields can
over-refine a large airbox volume. Authors that need a wider edge plume should
set `edge_transition_distance` explicitly; authors that need a wider corner
plume should set `corner_transition_distance` explicitly.

For axis-aligned rectangular bodies represented through a flat `ArchWaveguide`
(`arch_height = 0`), the production shared-domain path uses the same box OCC
lowering as `Box`. The air-side shell and transition fields must therefore use
an analytic distance-to-box field. This keeps the near-object air layer
continuous around the full object perimeter, including diagonal directions from
corners, and avoids asymmetric refinement from sampled OCC curve endpoints.

### 4.6 Comparison

For a 100 nm object with 5 nm interface mesh and 500 nm airbox radius:

| Grading     | Elements in air | Far-field quality |
|-------------|-----------------|-------------------|
| Linear      | ~50,000         | Over-refined      |
| Geometric   | ~5,000          | Optimal           |

## 5. API impact

### 5.1 New parameters

Add to `StudyBuilder.universe()` and `AirboxOptions`:

```python
study.universe(
    mode="auto",
    size=(500e-9, 500e-9, 500e-9),
    airbox_hmax=50e-9,           # existing: max element size
    airbox_growth_rate=1.3,      # NEW: geometric growth factor
    airbox_grading="geometric",  # NEW: "geometric" | "linear" | "auto"
)
```

### 5.2 Backward compatibility

- Default `airbox_grading="geometric"` for new scripts
- Existing scripts with explicit `grading_ratio` continue to work (interpreted as linear)
- Deprecation warning for linear grading

## 6. Validation strategy

1. **Element count**: geometric should produce ~5-10× fewer elements for same accuracy
2. **Quality metrics**: SICN distribution should not degrade
3. **Solver convergence**: demag field should match a Poisson-airbox or analytical reference
4. **Visual inspection**: no abrupt size jumps in mesh

## 7. Implementation checklist

- [x] Add `airbox_growth_rate` parameter to `AirboxOptions` lowering
- [x] Add `airbox_grading` parameter (geometric/linear/auto)
- [x] Implement `MathEval` field for geometric growth in `_gmsh_airbox.py`
- [x] Share geometric/linear airbox grading helper with production OCC path
- [x] Treat `airbox_hmin` as a size target instead of a gradient-length clamp
- [x] Use boundary-aware fallback distance instead of max-axis gap only
- [x] Add unrestricted air-side corner endpoint refinement field
- [x] Split edge and endpoint/corner transition distances from surface transition distance
- [x] Add realized distance-band regression tests for corners
- [x] Update `_size_field_plan.py` transition fields to use geometric growth
- [ ] Add full solver-quality validation for Poisson-airbox demag
- [ ] Deprecation warning for linear grading

## 8. References

1. COMSOL Multiphysics Reference Manual — Mesh Sequence Settings
2. Zienkiewicz, O.C. — The Finite Element Method, Ch. 15 (Mesh adaptation)
3. Gmsh documentation — Background mesh fields
