# Airbox mesh grading: geometric vs linear

- Status: draft
- Last updated: 2026-05-29
- Related specs: `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`
- Related code:
  - `packages/fullmag-py/src/fullmag/meshing/_airbox_grading.py`
  - `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`
  - `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py`
  - `packages/fullmag-py/src/fullmag/meshing/_gmsh_occ.py`
  - `packages/fullmag-py/src/fullmag/meshing/_size_field_plan.py`

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

The geometric growth model:

$$
h(r) = h_0 \cdot g^{r/h_0}
$$

where:
- h₀ = interface element size
- g = growth rate (typically 1.2–1.5)
- r = distance from interface

This gives logarithmic element count scaling with domain size, rather than linear.

## 3. Current implementation status

Geometric grading is partially implemented. The older GEO/OCC-fragment helpers
in `_gmsh_airbox.py` can build a `MathEval` exponential growth field, but the
production conformal OCC shared-domain path historically used only a linear
`Distance -> Threshold` field despite `AirboxOptions.grading_mode` defaulting to
`"geometric"`.

The corrected implementation must keep all airbox paths on the same grading
contract:

- `geometric`: exponential growth capped at `airbox_hmax`
- `linear`: legacy `Threshold` interpolation
- `airbox_hmin`: near-object size target, not gradient distance
- `DistMax`: distance to the relevant outer airbox boundary/corner or explicit
  transition span
- `edge_transition_distance`: optional boundary-curve grading span, distinct from
  the surface `transition_distance`
- `corner_transition_distance`: optional endpoint/corner grading span, distinct
  from both the surface and edge transition spans

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

Replace the Threshold field with a MathEval field that implements geometric growth:

```python
# Distance field (unchanged)
f_dist = gmsh.model.mesh.field.add("Distance")
gmsh.model.mesh.field.setNumbers(f_dist, "SurfacesList", interface_surfaces)

# Geometric growth via MathEval
f_growth = gmsh.model.mesh.field.add("MathEval")
growth_rate = 1.3  # standard COMSOL default
log_g = math.log(growth_rate)
# h(r) = h_inner * exp(ln(g) * dist / h_inner)
gmsh.model.mesh.field.setString(
    f_growth, "F",
    f"{h_inner} * exp({log_g} * F{f_dist} / {h_inner})"
)

# Cap at airbox_hmax
f_cap = gmsh.model.mesh.field.add("Min")
gmsh.model.mesh.field.setNumbers(f_cap, "FieldsList", [f_growth, f_const_hmax])
```

### 4.2 Parameter choices

| Parameter    | Description                          | Default | Range     |
|--------------|--------------------------------------|---------|-----------|
| growth_rate  | h_{n+1} / h_n ratio                 | 1.3     | 1.1–2.0   |
| h_inner      | Element size at magnetic interface   | hmax    | > 0       |
| airbox_hmax  | Maximum element size in far field    | 10×hmax | > h_inner |

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

For explicit rectangular airboxes, the implementation combines the local
surface-distance grading with a rectangular bbox envelope. The local field owns
the fine interface halo; the rectangular envelope keeps the remaining airbox
constrained until the outer boundary is reached, including diagonal directions
from object corners to airbox corners. This prevents a visually plausible halo
from degrading into a flat far-field plateau through most of the diagonal air
volume.

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
- [ ] Add realized distance-band regression tests for corners
- [ ] Update `_size_field_plan.py` transition fields to use geometric growth
- [ ] Add full solver-quality validation for Poisson-airbox demag
- [ ] Deprecation warning for linear grading

## 8. References

1. COMSOL Multiphysics Reference Manual — Mesh Sequence Settings
2. Zienkiewicz, O.C. — The Finite Element Method, Ch. 15 (Mesh adaptation)
3. Gmsh documentation — Background mesh fields
