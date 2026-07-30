# Bulk Dzyaloshinskii–Moriya interaction

- Status: canonical physics note
- Owners: Fullmag core
- Last updated: 2026-07-30
- Related notes: `docs/physics/0404-interfacial-dmi.md`, `docs/physics/0460-fdm-bulk-dmi.md`, `docs/physics/0470-fem-bulk-dmi-mfem-gpu.md`, `docs/physics/units.md`
- Publication owners: `public_docs/site/physics/interactions/dmi/bulk.md` and `public_docs/site/python-api/interactions/bulk-dmi.md`

## 1. Problem statement

This note is the canonical scientific owner for isotropic bulk
Dzyaloshinskii–Moriya interaction (bulk or Bloch DMI) in Fullmag. It owns the
energy convention, effective field, natural exchange-plus-DMI boundary term,
SI unit, Python and `ProblemIR` semantics, and all four numerical realization
lanes.

The public coefficient is $D_b$ in $\mathrm{J\,m^{-2}}$. It multiplies one
spatial derivative, so the resulting volume density has units
$\mathrm{J\,m^{-3}}$. Older planning notes are historical and are superseded
where they disagree with this unit or with the current implementation.

## 2. Physical model

Let $\Omega_m$ be the magnetic domain, $\mathbf M=M_s\mathbf m$ the physical
magnetization, and $\lvert\mathbf m\rvert=1$ on magnetic degrees of freedom.
Fullmag uses

$$
w_b(\mathbf m,\nabla\mathbf m)=D_b\,\mathbf m\cdot(\nabla\times\mathbf m),
\qquad
E_b[\mathbf m]=\int_{\Omega_m}w_b\,\mathrm dV.
$$

In components,

$$
\mathbf m\cdot(\nabla\times\mathbf m)
=m_x(\partial_y m_z-\partial_zm_y)
+m_y(\partial_zm_x-\partial_xm_z)
+m_z(\partial_xm_y-\partial_ym_x).
$$

For variation $\mathbf v$,

$$
\delta E_b
=D_b\int_{\Omega_m}\left[
\mathbf v\cdot(\nabla\times\mathbf m)
+\mathbf m\cdot(\nabla\times\mathbf v)\right]\mathrm dV.
$$

The vector identity
$\nabla\cdot(\mathbf v\times\mathbf m)
=\mathbf m\cdot(\nabla\times\mathbf v)
-\mathbf v\cdot(\nabla\times\mathbf m)$ gives

$$
\delta E_b
=2D_b\int_{\Omega_m}\mathbf v\cdot(\nabla\times\mathbf m)\,\mathrm dV
+D_b\int_{\partial\Omega_m}
(\mathbf v\times\mathbf m)\cdot\boldsymbol\nu\,\mathrm dS.
$$

Therefore

$$
\mathbf H_b=-\frac{2D_b}{\mu_0M_s}\nabla\times\mathbf m.
$$

The DMI boundary term is
$D_b\int_{\partial\Omega_m}[\mathbf m\times\boldsymbol\nu]\cdot\mathbf v\,\mathrm dS$.
With exchange stiffness $A$, the free boundary law is

$$
2A\,\partial_{\boldsymbol\nu}\mathbf m
+D_b(\mathbf m\times\boldsymbol\nu)=\mathbf0.
$$

This term is part of the variational problem. A zero-gradient stencil without
the DMI boundary contribution is not an equivalent free-surface realization.

## 3. Assumptions and validity

The current contract is one scalar isotropic cubic/B20-type invariant. It does
not claim support for a general Lifshitz tensor, lower-symmetry crystals,
surface-only DMI, or an independently authored DMI boundary operator.

The FDM planner accepts explicit Bulk DMI only when all three FDM axes are
periodic. Its local kernels have center-value substitution for inactive or
missing non-periodic neighbors, but that closure is not presented as the
natural exchange+DMI boundary. Multilayer FDM planning rejects Bulk DMI.

FEM uses a nodal vector field, quadrature weak residual, and lumped-mass field
projection. Its element coefficient is the arithmetic mean of nodal
`Dbulk_field` values.

## 4. Numerical realization

### 4.1 FDM CPU and GPU

The cell-centred reference uses

$$
(\delta_xm_\alpha)_i
=\frac{m_{\alpha,i+\hat x}-m_{\alpha,i-\hat x}}{2\Delta x},
\qquad
(\nabla_h\times\mathbf m)_i
=\begin{bmatrix}
\delta_ym_z-\delta_zm_y\\
\delta_zm_x-\delta_xm_z\\
\delta_xm_y-\delta_ym_x
\end{bmatrix}_i.
$$

Thus

$$
\mathbf H_{b,i}=-\frac{2D_b}{\mu_0M_{s,i}}
(\nabla_h\times\mathbf m)_i,
\qquad
E_b=\sum_{i\in\mathcal A}
D_b\,[\mathbf m_i\cdot(\nabla_h\times\mathbf m)_i]V_i.
$$

Periodic axes wrap. The FP64 and FP32 CUDA field/reduction paths use the same
curl sign. Source presence is not executed-device qualification.

### 4.2 FEM CPU and GPU

For element $e$, the native weak residual is

$$
R_{b,e}(\mathbf m_h;\mathbf v_h)
=D_{b,e}\int_{\Omega_e}\left[
\mathbf v_h\cdot(\nabla\times\mathbf m_h)
+\mathbf m_h\cdot(\nabla\times\mathbf v_h)\right]\mathrm dV.
$$

The quadrature energy is
$D_{b,e}[\mathbf m_q\cdot(\nabla\times\mathbf m_q)]w_q$. The field projection is

$$
H_{b,a}=-\frac{g_{b,a}}{\mu_0M_{s,a}M_a^{\mathrm{lump}}}.
$$

The CPU element loop owns the MFEM quadrature, weak residual, periodic input
projection, lumped projection, and joule energy. The GPU kernel evaluates the
same weak algebra with $bulk_mode$, atomic residual/energy blocks, resident RK
buffers, and a separate final Bulk DMI energy slot. CPU/GPU differ in
residency, atomics, reduction order, and round-off.

| Solver | Device | Status and evidence boundary |
|---|---|---|
| FDM | CPU | reference centered-curl lane; explicit planner requires all-axis periodicity |
| FDM | GPU | FP64/FP32 source-visible CUDA lane; executed-device parity still required |
| FEM | CPU | native MFEM weak-residual and lumped-projection lane |
| FEM | GPU | source-visible CUDA element/RK lane; executed-device qualification still required |

## 5. API, IR, planner, and provenance

`fullmag.BulkDMI(D)` lowers to

```json
{"kind": "bulk_dmi", "D": 0.003}
```

`Material.Dbulk` and `Material.Dbulk_field` lower to material keys
`bulk_dmi` and `dbulk_field`. Explicit and material routes are alternative
coefficient sources and are not silently summed. The Python constructor and IR
validator require finite values. FEM field cardinality is checked against the
resolved mesh.

Requested intent must remain separate from resolved execution: solver, device,
precision, coefficient route, boundary policy, field projection, and
qualification evidence belong to provenance. Non-periodic FDM and multilayer
FDM are planner failures, not CPU fallback.

## 6. Validation and completeness

Required checks are constant-magnetization zero response, analytic linear-field
curl components, sign reversal under $D_b\mapsto-D_b$, FDM CPU/GPU same-periodic
grid comparison, FEM weak-residual tetrahedral integration, FEM CPU/GPU field
and energy comparison, Python/IR round-trip, and fail-closed planner tests.
Compilation or source inspection does not prove GPU parity.

Known limits are the absent non-periodic FDM natural boundary lane, rejected
multilayer FDM Bulk DMI, and absent lower-symmetry DMI tensors. The historical
`Material.Dbulk` suspicious-value warning labels its warning unit as
`J/m^3`; the current public ABI is `J/m^2`. Correcting that warning is a
separate code change.

## 7. Source index

| Claim | Repository path and stable symbol |
|---|---|
| Python constructor | `packages/fullmag-py/src/fullmag/model/energy.py` — `class BulkDMI` |
| material routes | `packages/fullmag-py/src/fullmag/model/structure.py` — `class Material` |
| FDM periodicity | `packages/fullmag-py/src/fullmag/model/problem.py` — `class FdmPbc` |
| IR validation | `crates/fullmag-ir/src/validation.rs` — `validate_dmi_energy_terms`, `validate_material_dmi_values` |
| FDM planner | `crates/fullmag-plan/src/fdm.rs` — `plan_fdm` |
| FEM planner | `crates/fullmag-plan/src/fem.rs` — `plan_fem` |
| FDM CPU field/energy | `crates/fullmag-engine/src/fdm/cpu/fields.rs` — `dmi_energy_density_from_vectors`, `bulk_dmi_field`, `dmi_energy_from_soa` |
| FDM GPU field | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` — `combine_effective_field_fp64_kernel` |
| FEM CPU realization | `backends/fem/cpu/mfem/interactions/dmi_bulk.cpp` — `compute_bulk_dmi_field` |
| FEM weak residual/projection | `backends/fem/src/dmi_weak_residual.cpp` — `dmi_accumulate_bulk_residual`, `dmi_project_lumped_field` |
| FEM GPU kernel | `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu` — `dmi_element_residual_kernel` |
| FEM GPU field dispatch | `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu` — `gpu_rk_compute_dmi_field_contributions` |
| FEM GPU energy reduction | `backends/fem/gpu/cuda/integrators/rk/rk_dmi_energy_reductions.cu` — `gpu_rk_reduce_final_dmi_energy_terms` |
