---
title: Bulk Dzyaloshinskii–Moriya interaction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0405-bulk-dmi.md
---

(public-docs-physics-interactions-dmi-bulk)=
# Bulk Dzyaloshinskii–Moriya interaction

This is the canonical public reference for isotropic bulk
Dzyaloshinskii–Moriya interaction (bulk or Bloch DMI). Common physics is
defined once here; FDM/FEM and CPU/GPU differences are realization sections.

The public coefficient is $D_b$ in $\mathrm{J\,m^{-2}}$. It multiplies one
spatial derivative, so the resulting volume density is in
$\mathrm{J\,m^{-3}}$.

(bulk-dmi-problem-statement)=
## 1. Physical problem

Let $\Omega_m$ be the magnetic domain and
$\mathbf M=M_s\mathbf m$ the physical magnetization, with
$\lvert\mathbf m\rvert=1$ on magnetic degrees of freedom:

```{math}
:label: eq-bulk-dmi-density
w_b(\mathbf m,\nabla\mathbf m)=D_b\,\mathbf m\cdot(\nabla\times\mathbf m).
```

```{math}
:label: eq-bulk-dmi-energy
E_b[\mathbf m]=\int_{\Omega_m}w_b\,\mathrm dV.
```

```{math}
:label: eq-bulk-dmi-cartesian
\mathbf m\cdot(\nabla\times\mathbf m)
=m_x(\partial_y m_z-\partial_zm_y)
+m_y(\partial_zm_x-\partial_xm_z)
+m_z(\partial_xm_y-\partial_ym_x).
```

This is a volume invariant, distinct from interfacial DMI.

(bulk-dmi-governing-equations)=
## 2. Governing equations

For an admissible variation $\mathbf v$,

```{math}
:label: eq-bulk-dmi-first-variation
\delta E_b(\mathbf m;\mathbf v)
=D_b\int_{\Omega_m}
\left[\mathbf v\cdot(\nabla\times\mathbf m)
+\mathbf m\cdot(\nabla\times\mathbf v)\right]\mathrm dV.
```

Using
$\nabla\cdot(\mathbf v\times\mathbf m)
=\mathbf m\cdot(\nabla\times\mathbf v)
-\mathbf v\cdot(\nabla\times\mathbf m)$:

```{math}
:label: eq-bulk-dmi-variation-separated
\delta E_b
=2D_b\int_{\Omega_m}\mathbf v\cdot(\nabla\times\mathbf m)\,\mathrm dV
+D_b\int_{\partial\Omega_m}
(\mathbf v\times\mathbf m)\cdot\boldsymbol\nu\,\mathrm dS.
```

With the Fullmag energy-field convention
$\delta E=-\mu_0\int_{\Omega_m}M_s\mathbf H_b\cdot\mathbf v\,\mathrm dV$:

```{math}
:label: eq-bulk-dmi-effective-field
\mathbf H_b=-\frac{2D_b}{\mu_0M_s}(\nabla\times\mathbf m).
```

The natural boundary term and exchange-coupled free boundary law are

```{math}
:label: eq-bulk-dmi-boundary-term
\delta E_b^{\partial\Omega}
=D_b\int_{\partial\Omega_m}
[\mathbf m\times\boldsymbol\nu]\cdot\mathbf v\,\mathrm dS.
```

```{math}
:label: eq-bulk-dmi-exchange-boundary
2A\,\partial_{\boldsymbol\nu}\mathbf m
+D_b(\mathbf m\times\boldsymbol\nu)=\mathbf0.
```

The non-periodic FDM planner does not expose this natural closure and fails
closed; FEM carries it through the weak residual.

(bulk-dmi-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf M$ | physical magnetization $M_s\mathbf m$ | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf v$ | admissible variation or test field | $1$ |
| $D_b$ | bulk DMI coefficient | $\mathrm{J\,m^{-2}}$ |
| $A$ | exchange stiffness in the coupled boundary law | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic integration domain | $\mathrm{m^3}$ |
| $\partial\Omega_m$ | magnetic boundary | $\mathrm{m^2}$ |
| $\boldsymbol\nu$ | outward unit normal | $1$ |
| $w_b$ | bulk DMI energy density | $\mathrm{J\,m^{-3}}$ |
| $E_b$ | total bulk DMI energy | $\mathrm{J}$ |
| $\mathbf H_b$ | bulk DMI effective field | $\mathrm{A\,m^{-1}}$ |
| $m_\alpha$ | Cartesian magnetization component | $1$ |
| $\partial_\alpha$ | spatial derivative | $\mathrm{m^{-1}}$ |
| $\delta_\alpha$ | centered FDM derivative | $\mathrm{m^{-1}}$ |
| $\nabla_h\times$ | centered discrete curl operator | $\mathrm{m^{-1}}$ |
| $\Delta x$ | FDM x cell dimension | $\mathrm{m}$ |
| $\Delta y$ | FDM y cell dimension | $\mathrm{m}$ |
| $\Delta z$ | FDM z cell dimension | $\mathrm{m}$ |
| $i$ | FDM cell index | $1$ |
| $\mathcal A$ | active FDM cell set | $1$ |
| $V_i$ | FDM cell volume | $\mathrm{m^3}$ |
| $\mathbf m_h$ | FEM finite-element magnetization | $1$ |
| $\mathbf v_h$ | FEM finite-element test field | $1$ |
| $\Omega_e$ | FEM element domain | $\mathrm{m^3}$ |
| $q$ | quadrature point index | $1$ |
| $D_{b,e}$ | element bulk DMI coefficient | $\mathrm{J\,m^{-2}}$ |
| $\mathbf m_q$ | quadrature-point magnetization | $1$ |
| $w_q$ | quadrature weight including element Jacobian | $\mathrm{m^3}$ |
| $g_{b,a}$ | assembled bulk-DMI residual at node a | $\mathrm{J}$ |
| $M_{s,a}$ | nodal saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_a^{\mathrm{lump}}$ | nodal lumped mass | $\mathrm{m^3}$ |
| $H_{b,a}$ | projected nodal bulk-DMI field | $\mathrm{A\,m^{-1}}$ |

(bulk-dmi-assumptions-and-validity)=
## 4. Assumptions and validity

- The invariant is isotropic cubic/B20-type bulk DMI with one finite scalar
  coefficient; either sign is accepted and selects chirality.
- FDM uses a centered cell curl. Periodic neighbors wrap; missing/inactive
  non-periodic neighbors use the center value.
- Explicit FDM Bulk DMI requires all three axes periodic. Multilayer FDM
  rejects it.
- FEM uses a nodal vector field, quadrature weak residual, and lumped-mass
  projection. The element coefficient is the arithmetic mean of nodal
  Dbulk_field values.
- General Lifshitz tensors, lower-symmetry crystals, surface-only DMI, and an
  independent DMI boundary operator are outside this contract.

(bulk-dmi-python-api)=
## 5. Python API

The current stage-first body API exposes the scalar bulk-DMI route as `body.Dbulk`. The builder
lowers it to a `BulkDMI` energy term. The FDM planner requires all three axes to be periodic, so
the complete helical-state scenario declares that policy explicitly and disables demagnetization
to isolate the bulk-DMI field and energy.

```python
# %% Imports and units
import math

import fullmag as fm

nm = 1.0e-9
period = 40 * nm
wave_number = 2.0 * math.pi / period

# %% Fully periodic FDM study required by bulk DMI
study = fm.study("bulk_dmi_helical_state")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.pbc(x=True, y=True, z=True)
study.fdm(default_cell=(2 * nm, 2 * nm, 2 * nm))

# %% Geometry, B20 material, transverse helix, and interactions
crystal = study.geometry(
    fm.Box(size=(80 * nm, 16 * nm, 16 * nm), name="crystal"),
    name="crystal",
)
crystal.Ms = 3.84e5
crystal.Aex = 8.78e-12
crystal.Dbulk = 1.58e-3
crystal.alpha = 0.02
crystal.m = fm.texture.helical(
    wavevector=(wave_number, 0.0, 0.0),
    e1=(0.0, 1.0, 0.0),
    e2=(0.0, 0.0, 1.0),
)
study.exchange()
study.demag(enabled=False)
study.solver(integrator="rk4", fix_dt=1.0e-14)

# %% Ordered measurement stage
study.stages.add_run(stage_id="measure_bulk_dmi", until=1.0e-12).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            t_sampl=1.0e-13,
            quantities=["t", "mx", "my", "mz", "e_ex", "e_dmi", "e_total"],
        ),
        fields=[fm.FieldAutosave("H_dmi_bulk", every=2.0e-13)],
    )
)
```

| Python parameter | Type | Default | SI unit | Validation domain | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `BulkDMI.D` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite; either sign | explicit bulk-DMI coefficient and chirality sign | FDM/FEM CPU/GPU subject to planner and qualification gates | `energy_terms[].D` for `kind=bulk_dmi` |
| `Material.Dbulk` | `float \| None` | `None` | $\mathrm{J\,m^{-2}}$ | finite when supplied | material-owned scalar bulk-DMI coefficient | FEM CPU/GPU; FDM planner-dependent | `materials[].bulk_dmi` |
| `Material.Dbulk_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-2}}$ | finite values; resolved mesh cardinality | spatial nodal bulk-DMI coefficient | FEM CPU/GPU | `materials[].dbulk_field` |
| `FdmPbc.axes` | `tuple[bool,bool,bool]` | required | $1$ | exactly three values | periodic/open axes | FDM CPU/GPU | `pbc.axes` |
| `FdmPbc.demag` | `str` | `"open"` | $1$ | three declared demag strings | FDM demag policy | FDM | `pbc.demag` |
| `FdmPbc.image_counts` | `tuple[int,int,int] \| None` | `None` | $1$ | non-negative; truncated images only | image counts | FDM | `pbc.image_counts` |

The other required Material parameters (name, Ms, A, alpha) are documented
by the canonical Material API page.

(bulk-dmi-problem-ir)=
## 6. ProblemIR

Explicit authoring serializes as:

```json
{"kind": "bulk_dmi", "D": 0.003}
```

Material authoring serializes as:

```json
{"bulk_dmi": 0.003, "dbulk_field": null}
```

The explicit and material routes are alternative coefficient sources and are
not silently summed. The FEM planner can use the material scalar when no
explicit scalar supplies the coefficient and promotes a material field into
the resolved FEM field. FdmPbc converts booleans to periodic/open strings.
Requested Python intent is preserved separately from resolved execution:
solver, device, precision, route, boundary policy, projection, and
qualification evidence are provenance data.

(bulk-dmi-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

Canonical script export preserves explicit BulkDMI(D=...) versus
Material(Dbulk=...)/Material(Dbulk_field=...). Normalization never turns bulk
DMI into interfacial DMI or invents a non-periodic FDM boundary.

Validation errors include non-finite coefficients, malformed FDM tuples,
material-field cardinality mismatch, invalid IR terms, missing FEM context,
and missing resident GPU buffers. The FDM planner rejects explicit Bulk DMI
unless all three axes are periodic and rejects multilayer FDM.

Unsupported combinations are planner/runtime failures, not CPU fallback,
silent term removal, or a claim of backend parity. Requested intent and
resolved execution remain separately inspectable.

(bulk-dmi-discrete-realization)=
## 8. Discrete realization

### FDM CPU

```{math}
:label: eq-bulk-dmi-fdm-derivative
(\delta_xm_\alpha)_i=\frac{m_{\alpha,i+\hat x}-m_{\alpha,i-\hat x}}{2\Delta x},
\quad
(\delta_ym_\alpha)_i=\frac{m_{\alpha,i+\hat y}-m_{\alpha,i-\hat y}}{2\Delta y},
\quad
(\delta_zm_\alpha)_i=\frac{m_{\alpha,i+\hat z}-m_{\alpha,i-\hat z}}{2\Delta z}.
```

```{math}
:label: eq-bulk-dmi-fdm-field
(\nabla_h\times\mathbf m)_i=
\begin{bmatrix}\delta_ym_z-\delta_zm_y\\
\delta_zm_x-\delta_xm_z\\
\delta_xm_y-\delta_ym_x\end{bmatrix}_i,
\qquad
\mathbf H_{b,i}^{\mathrm{FDM}}=
-\frac{2D_b}{\mu_0M_{s,i}}(\nabla_h\times\mathbf m)_i.
```

```{math}
:label: eq-bulk-dmi-fdm-energy
E_b^{\mathrm{FDM}}=\sum_{i\in\mathcal A}
D_b\left[\mathbf m_i\cdot(\nabla_h\times\mathbf m)_i\right]V_i.
```

### FDM GPU

FP64 and FP32 CUDA field-combination kernels use the same negative-curl
convention and the CUDA reduction sums the bulk density. The planner still
requires fully periodic axes; source presence is not device qualification.

### FEM CPU

```{math}
:label: eq-bulk-dmi-fem-weak-residual
R_{b,e}(\mathbf m_h;\mathbf v_h)=D_{b,e}\int_{\Omega_e}
\left[\mathbf v_h\cdot(\nabla\times\mathbf m_h)
+\mathbf m_h\cdot(\nabla\times\mathbf v_h)\right]\mathrm dV.
```

```{math}
:label: eq-bulk-dmi-fem-energy
E_{b,e}=D_{b,e}\sum_q
\left[\mathbf m_q\cdot(\nabla\times\mathbf m_q)\right]w_q.
```

```{math}
:label: eq-bulk-dmi-fem-projection
H_{b,a}=-\frac{g_{b,a}}{\mu_0M_{s,a}M_a^{\mathrm{lump}}}.
```

The native loop uses the arithmetic mean of nodal Dbulk_field, periodic
reduced-node projection, MFEM quadrature, and lumped projection.

### FEM GPU

The CUDA dmi_element_residual_kernel has a bulk mode for tetrahedral
gradients, coefficient, curl, residual, and energy blocks. RK dispatch uses
resident h_bulk_dmi, geometry, saturation, lumped-mass, and residual buffers.
Final reduction owns a separate Bulk DMI energy slot. Atomic accumulation and
reduction order differ from CPU.

(bulk-dmi-implementation-mapping)=
## 9. Implementation mapping

| Layer | FDM CPU | FDM GPU | FEM CPU | FEM GPU |
|---|---|---|---|---|
| coefficient | explicit scalar | device D_bulk | scalar or nodal mean | resident material field |
| field | centered curl | FP64/FP32 centered curl | weak residual + lumped projection | CUDA residual + RK projection |
| energy | active-cell volume sum | CUDA reduction | quadrature sum | element blocks + final slot |
| boundary | all-axis periodic gate | same gate | weak residual term | same weak form |
| failure | non-periodic/multilayer rejection | same gate | invalid context/buffers | missing resources/evidence |

(bulk-dmi-validation)=
## 10. Validation

| Check | Expected result | Evidence boundary |
|---|---|---|
| constant m | zero curl, field, energy | analytical/unit test |
| linear Cartesian field | analytic curl components | analytical/unit test |
| D_b to -D_b | field and energy sign reverse | CPU/backend test |
| FDM CPU/GPU | same periodic FP64 grid within tolerance | managed device run |
| FEM weak residual | tetrahedral reference agreement | weak-residual test |
| FEM CPU/GPU | field and final energy agreement | managed native runtime |
| planner gate | non-periodic/multilayer fails closed | planner test |
| Python round-trip | explicit/material routes distinct | Python/IR test |

Compilation, source inspection, and skipped GPU tests are not proof of
executed-device parity.

(bulk-dmi-limitations)=
## 11. Limitations

- Non-periodic FDM natural exchange+DMI boundary conditions are not exposed.
- Multilayer FDM Bulk DMI is rejected.
- Lower-symmetry/tensorial DMI families are outside this contract.
- The material-field element reduction is an arithmetic nodal mean.
- Historical Material.Dbulk warning text uses $\mathrm{J\,m^{-3}}$, while the
  public coefficient contract uses $\mathrm{J\,m^{-2}}$.

(bulk-dmi-scientific-bibliography)=
## 12. Scientific bibliography

1. A. N. Bogdanov and D. A. Yablonskii, “Thermodynamically stable vortices
   in magnetically ordered crystals,” *Soviet Physics JETP* 68, 101 (1989).
2. A. N. Bogdanov and U. K. Rößler, “Chiral symmetry breaking in magnetic
   thin films and multilayers,” *Physical Review Letters* 87, 037203 (2001),
   [doi:10.1103/PhysRevLett.87.037203](https://doi.org/10.1103/PhysRevLett.87.037203).

(bulk-dmi-source-code-index)=
## 13. Source-code index

| Equation or claim | Repository path | Stable symbol | Responsibility | Lane/evidence |
|---|---|---|---|---|
| explicit constructor and IR | `packages/fullmag-py/src/fullmag/model/energy.py` | `class BulkDMI` | finite scalar and serialization | Python contract |
| material route | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | scalar/field serialization | Python contract |
| FDM periodicity | `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | axes/policy validation | Python contract |
| IR explicit validation | `crates/fullmag-ir/src/validation.rs` | `validate_dmi_energy_terms` | finite explicit value | IR contract |
| IR material validation | `crates/fullmag-ir/src/validation.rs` | `validate_material_dmi_values` | finite material values | IR contract |
| FDM planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | periodic gate and lowering | FDM planning |
| FEM planner | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | material/explicit resolution | FEM planning |
| FDM CPU density | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `dmi_energy_density_from_vectors` | centered curl density | FDM CPU |
| FDM CPU field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `bulk_dmi_field` | negative-curl field | FDM CPU |
| FDM CPU SoA energy | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `dmi_energy_from_soa` | volume reduction | FDM CPU |
| FDM CUDA field | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | FP64 bulk field | FDM GPU |
| FEM CPU realization | `backends/fem/cpu/mfem/interactions/dmi_bulk.cpp` | `compute_bulk_dmi_field` | quadrature/residual/projection/energy | FEM CPU |
| FEM weak residual | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_bulk_residual` | residual algebra | FEM CPU/GPU |
| FEM projection | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_project_lumped_field` | residual-to-field | FEM CPU/GPU |
| FEM CUDA kernel | `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu` | `dmi_element_residual_kernel` | residual/energy blocks | FEM GPU |
| FEM CUDA dispatch | `backends/fem/gpu/cuda/integrators/rk/rk_dmi_fields.cu` | `gpu_rk_compute_dmi_field_contributions` | resident field dispatch | FEM GPU |
| FEM CUDA reduction | `backends/fem/gpu/cuda/integrators/rk/rk_dmi_energy_reductions.cu` | `gpu_rk_reduce_final_dmi_energy_terms` | final energy slot | FEM GPU |
