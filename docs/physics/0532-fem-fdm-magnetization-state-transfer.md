# FEM→FDM magnetization state transfer

- Status: draft
- Owners: fullmag core
- Last updated: 2026-04-16
- Related ADRs: —
- Related specs: docs/physics/0531-fem-demag-transfer-grid-removal.md

## 1. Problem statement

After computing an equilibrium or time-evolved magnetization state on an FEM
(tetrahedral) mesh, a user may wish to continue the simulation on an FDM
(Cartesian) grid — for example to leverage FFT-based demag or GPU-accelerated
time integration. This requires transferring the magnetization field **m** from
FEM node positions to FDM cell centers.

This is a **state-transfer** operation, not a demag realization. The old
`transfer_grid` demag path (removed in 0531) conflated resampling with demag
computation. This note defines a clean, demag-independent mechanism.

## 2. Physical model

### 2.1 Governing equations

The magnetization unit vector field $\mathbf{m}(\mathbf{r})$ is defined on the
FEM mesh at P1 node positions. For transfer, we need to evaluate
$\mathbf{m}(\mathbf{r}_c)$ at each FDM cell center $\mathbf{r}_c$.

Within each tetrahedron with nodes $\{\mathbf{r}_i\}_{i=0}^3$ and nodal values
$\{\mathbf{m}_i\}_{i=0}^3$, the P1 interpolant is:

$$\mathbf{m}(\mathbf{r}) = \sum_{i=0}^{3} \lambda_i(\mathbf{r})\,\mathbf{m}_i$$

where $\lambda_i$ are the barycentric coordinates satisfying
$\sum_i \lambda_i = 1$, $\lambda_i \geq 0$ inside the element.

After interpolation, the result is renormalized to unit length:

$$\mathbf{m}_\text{out} = \frac{\mathbf{m}(\mathbf{r}_c)}{|\mathbf{m}(\mathbf{r}_c)|}$$

Cells outside the FEM mesh receive $\mathbf{m} = \mathbf{0}$ (inactive cells in
the FDM grid).

### 2.2 Symbols and SI units

| Symbol | Meaning | Unit |
|--------|---------|------|
| $\mathbf{m}$ | magnetization unit vector | dimensionless |
| $\mathbf{r}_c$ | FDM cell center position | m |
| $\lambda_i$ | barycentric coordinate | dimensionless |
| $M_s$ | saturation magnetization | A/m |

$M_s$ is **not** transferred — each backend uses its own material definition.

### 2.3 Assumptions and approximations

1. FEM field is P1 (piecewise linear on tetrahedra).
2. v1 uses per-point BVH lookup + barycentric interpolation (same as existing
   `transfer_vector_field` for FEM→FEM).
3. Cells whose centers fall outside all tetrahedra get $\mathbf{m} = \mathbf{0}$.
   These should correspond to inactive (outside-geometry) FDM cells.
4. Post-transfer normalization is mandatory: P1 interpolation of unit vectors
   does not generally produce unit vectors.
5. Only $\mathbf{m}$ is transferred. $\mathbf{H}_\text{demag}$,
   $\mathbf{H}_\text{eff}$, and all derived quantities are recomputed by the
   FDM backend from its own discretization.

**Known v1 limitation**: Per-point sampling does not perform volume-weighted
projection. A cell center inside a small tetrahedron tip receives the same
weight as one in a large interior element. For strongly non-uniform FEM meshes,
this may introduce local bias. Volume-weighted tet–cell intersection projection
is deferred to v2.

## 3. Numerical interpretation

### 3.1 FDM

FDM is the **target** of the transfer. After receiving resampled
$\mathbf{m}$, the FDM backend calls `refresh_observables()` to recompute
$\mathbf{H}_\text{eff}$ from its own operators (FFT demag, finite-difference
exchange, etc.). No FEM-derived field is carried over.

### 3.2 FEM

FEM is the **source** of the transfer. The FEM backend exposes `copy_m()` to
read the current nodal magnetization. The FEM backend does not need to know
anything about the target FDM grid.

### 3.3 Hybrid

No hybrid semantics. The transfer is a discrete event between two independent
backend executions, orchestrated by the runner.

## 4. API, IR, and planner impact

### 4.1 Python API surface

**v1**: No new Python API verb. When a flat stage sequence switches from FEM to
FDM, the runner automatically resamples $\mathbf{m}$. The existing
`SampledMagnetization` / `SampledField` continuation mechanism carries the
resampled values.

**Future**: An explicit `fm.transfer_state(source="fem", target="fdm")` may be
added when users need fine-grained control over the transfer.

### 4.2 ProblemIR representation

No new IR variant. `InitialMagnetizationIR::SampledField { values }` is the
carrier. Resampling happens at runner level before constructing the FDM plan IR.

### 4.3 Planner and capability-matrix impact

No changes to the capability matrix. The planner may emit an informational note
when a cross-backend stage sequence is detected (FEM→FDM), but this is not a
hard validation gate for v1.

## 5. Runtime/session/artifact/provenance impact

`ExecutionProvenance` gains optional fields:

- `state_transfer_source: Option<String>` — e.g. `"fem:<mesh_name>"`
- `state_transfer_method: Option<String>` — e.g. `"p1_barycentric_bvh"`
- `state_transfer_located: Option<usize>` — cells successfully interpolated
- `state_transfer_outside: Option<usize>` — cells outside FEM mesh (set to zero)

## 6. Validation strategy

### 6.1 Analytical checks

- Uniform FEM field transferred to any grid produces the same uniform field.
- Linear FEM field $\mathbf{m}(\mathbf{r}) = \hat{\mathbf{r}}/|\hat{\mathbf{r}}|$
  transferred to a matching grid recovers the field within P1 interpolation
  tolerance.

### 6.2 Cross-backend checks

- FEM relax → FDM continuation: $\langle\mathbf{m}\rangle$ must be preserved
  within interpolation error (~$10^{-3}$ for P1 on typical meshes).
- FDM $\mathbf{H}_\text{eff}$ after transfer must be computed from FDM
  operators, not inherited from FEM.

### 6.3 Regression tests

- Engine: `transfer_fem_field_to_grid()` unit tests for uniform, linear, and
  outside-mesh cases.
- Post-transfer normalization: verify $|\mathbf{m}| = 1$ for all active cells.

## 7. Completeness checklist

- [x] Physics note
- [x] Engine resampler (`transfer_fem_field_to_grid`)
- [x] Post-transfer normalization
- [x] Unit tests
- [x] Runner orchestration (Rust orchestrator + Python CLI)
- [x] Provenance metadata (transfer stats logged at info level)
- [x] Integration tests (step_utils cross-backend tests)
- [ ] Documentation update

## 8. Known limits and deferred work

- **Volume-weighted projection**: v1 is per-point; v2 should compute tet–cell
  intersection volumes for better accuracy on non-uniform meshes.
- **FDM→FEM transfer**: Not in scope. Different challenges (scattered-point
  interpolation on a regular grid, easier with trilinear).
- **Multi-magnet**: v1 supports single-magnet cross-backend continuation only.
  Per-magnet resampling for multi-body problems deferred to v2.
- **Active mask**: FDM cells outside geometry receive $\mathbf{m} = \mathbf{0}$.
  The FDM plan construction already handles this for `SampledField`.

## 9. References

- `docs/physics/0531-fem-demag-transfer-grid-removal.md`
- `crates/fullmag-engine/src/fem_solution_transfer.rs` (existing BVH + P1 interpolation)
- `docs/specs/magnetization-init-policy-v0.md` (SampledField contract)
