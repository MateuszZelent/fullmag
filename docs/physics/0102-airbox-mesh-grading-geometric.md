# Airbox mesh grading: geometric vs linear

- Status: draft
- Last updated: 2026-05-27
- Related specs: `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`
- Related code: `packages/fullmag-py/src/fullmag/meshing/_gmsh_airbox.py`

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

## 3. Current implementation (problematic)

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

### 4.4 Comparison

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

- [ ] Add `airbox_growth_rate` parameter to `AirboxOptions`
- [ ] Add `airbox_grading` parameter (geometric/linear/auto)
- [ ] Implement `MathEval` field for geometric growth in `_gmsh_airbox.py`
- [ ] Update `_size_field_plan.py` transition fields to use geometric growth
- [ ] Add unit tests for growth rate calculation
- [ ] Update documentation
- [ ] Deprecation warning for linear grading

## 8. References

1. COMSOL Multiphysics Reference Manual — Mesh Sequence Settings
2. Zienkiewicz, O.C. — The Finite Element Method, Ch. 15 (Mesh adaptation)
3. Gmsh documentation — Background mesh fields
