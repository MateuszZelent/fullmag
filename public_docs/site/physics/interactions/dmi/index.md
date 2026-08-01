---
title: Dzyaloshinskii–Moriya interaction
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0404-interfacial-dmi.md and docs/physics/0405-bulk-dmi.md
---

(public-docs-physics-interactions-dmi-root)=
# Dzyaloshinskii–Moriya interaction

This is the canonical physical owner for the two Dzyaloshinskii–Moriya interaction (DMI)
families currently represented by FullMag: interfacial DMI and isotropic bulk DMI. The shared
micromagnetic conventions, coefficient units, Python-to-`ProblemIR` boundary, and four solver
lanes are stated here once. The independently useful physics and numerical details live in the
subtree below.

DMI is an antisymmetric exchange interaction. It is not the same as ordinary exchange: exchange
penalizes gradients quadratically, while DMI is linear in a first spatial derivative and selects
a chirality. It is also not a hidden boundary-condition flag. The natural DMI boundary term is a
consequence of the same variational functional and must be treated consistently with exchange.

```{toctree}
:maxdepth: 1

interfacial
bulk
boundary-conditions
validation
```

(dmi-problem-statement)=
## Physical problem

Let $Omega_m$ be the magnetic domain, $mathbf M$ the physical magnetization,
$M_s>0$ the saturation magnetization, and
$mathbf m=mathbf M/M_s$ the reduced magnetization. FullMag exposes the DMI field in
$\mathrm{A\,m^{-1}}$ and the DMI energy in $mathrm{J}$. The coefficient of either DMI family is
an areal energy coefficient in $mathrm{J,m^{-2}}$ because the invariant contains one spatial
derivative.

FullMag has two symmetry families:

| Family | Continuum invariant | Typical physical setting | Canonical page |
|---|---|---|---|
| Interfacial DMI | $D_{mathrm i}[(\mathbf m\cdot\hat{\mathbf n})\nabla\cdot\mathbf m-\mathbf m\cdot\nabla(\mathbf m\cdot\hat{\mathbf n})]$ | inversion breaking at a thin-film interface | {doc}`interfacial` |
| Bulk DMI | $D_{mathrm b}\,\mathbf m\cdot(\nabla\times\mathbf m)$ | non-centrosymmetric bulk crystals | {doc}`bulk` |

The variants are not interchangeable. Their signs, boundary terms, finite-difference stencils,
and FEM weak residuals are different even when they are enabled in the same `Problem`.

(dmi-governing-equations)=
## Governing equations

### Interfacial DMI

For a unit interface-symmetry normal $hat{\mathbf n}$, the interfacial energy density is

```{math}
:label: eq-dmi-interfacial-density
w_{\mathrm i}(\mathbf m,\nabla\mathbf m)
=D_{\mathrm i}\left[(\mathbf m\cdot\hat{\mathbf n})\,\nabla\cdot\mathbf m
-\mathbf m\cdot\nabla(\mathbf m\cdot\hat{\mathbf n})\right].
```

The corresponding energy and effective field convention are

```{math}
:label: eq-dmi-interfacial-energy-field
E_{\mathrm i}[\mathbf m]=\int_{\Omega_m}w_{\mathrm i}\,\mathrm dV,
\qquad
\mathbf H_{\mathrm i}
=\frac{2D_{\mathrm i}}{\mu_0M_s}
\left[\nabla(\mathbf m\cdot\hat{\mathbf n})
-(\nabla\cdot\mathbf m)\hat{\mathbf n}\right].
```

The FDM lane currently accepts only $hat{\mathbf n}=\hat{\mathbf z}$. FEM normalizes a finite,
non-zero user vector and retains the general contraction. The natural boundary term and its
exchange-coupled form are documented in {doc}`boundary-conditions` and on the family page.

### Bulk DMI

For isotropic bulk/B20-type DMI, the volume density is

```{math}
:label: eq-dmi-bulk-density
w_{\mathrm b}(\mathbf m,\nabla\mathbf m)
=D_{\mathrm b}\,\mathbf m\cdot(\nabla\times\mathbf m).
```

Its energy and effective field are

```{math}
:label: eq-dmi-bulk-energy-field
E_{\mathrm b}[\mathbf m]=\int_{\Omega_m}w_{\mathrm b}\,\mathrm dV,
\qquad
\mathbf H_{\mathrm b}
=-\frac{2D_{\mathrm b}}{\mu_0M_s}(\nabla\times\mathbf m).
```

The sign difference between the interfacial and bulk field is part of the implementation
contract. It must not be removed by taking an absolute value of $D$ or by reusing the
interfacial stencil for bulk DMI.

### Energy and observables

When both families are active, the DMI contribution is additive at the physical level:

```{math}
:label: eq-dmi-total-energy-field
E_{\mathrm{DMI}}=E_{\mathrm i}+E_{\mathrm b},
\qquad
\mathbf H_{\mathrm{DMI}}=\mathbf H_{\mathrm i}+\mathbf H_{\mathrm b}.
```

The backend may expose family-specific fields such as `H_dmi` and `H_dmi_bulk`, together with
family-specific energy scalars. Their availability is a planner/runtime contract; source code
containing a kernel does not by itself make an observable available on every lane.

(dmi-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m$ | reduced magnetization $\mathbf M/M_s$ | $1$ |
| $\mathbf M$ | physical magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $D_{\mathrm i}$ | interfacial DMI coefficient | $\mathrm{J\,m^{-2}}$ |
| $D_{\mathrm b}$ | bulk DMI coefficient | $\mathrm{J\,m^{-2}}$ |
| $A$ | exchange stiffness in the coupled boundary law | $\mathrm{J\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\hat{\mathbf n}$ | normalized interfacial symmetry normal | $1$ |
| $\boldsymbol\nu$ | outward magnetic-boundary normal | $1$ |
| $\Omega_m$ | magnetic integration domain | $\mathrm{m^3}$ |
| $\partial\Omega_m$ | magnetic boundary | $\mathrm{m^2}$ |
| $w_{\mathrm i}$ | interfacial DMI energy density | $\mathrm{J\,m^{-3}}$ |
| $w_{\mathrm b}$ | bulk DMI energy density | $\mathrm{J\,m^{-3}}$ |
| $E_{\mathrm i}$ | interfacial DMI energy | $\mathrm{J}$ |
| $E_{\mathrm b}$ | bulk DMI energy | $\mathrm{J}$ |
| $E_{\mathrm{DMI}}$ | total DMI energy | $\mathrm{J}$ |
| $\mathbf H_{\mathrm i}$ | interfacial DMI effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm b}$ | bulk DMI effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm{DMI}}$ | total DMI effective field | $\mathrm{A\,m^{-1}}$ |
| $\nabla\times$ | continuum curl operator | $\mathrm{m^{-1}}$ |
| $\nabla_h\times$ | centered FDM curl operator | $\mathrm{m^{-1}}$ |
| $\delta_\alpha$ | centered derivative along coordinate $\alpha$ | $\mathrm{m^{-1}}$ |
| $\Delta x,\Delta y,\Delta z$ | FDM cell dimensions | $\mathrm{m}$ |
| $V_i$ | volume of FDM cell $i$ | $\mathrm{m^3}$ |
| $i$ | FDM cell or FEM node index | $1$ |
| $\mathcal A$ | active magnetic FDM cell set | $1$ |
| $\mathbf v$ | admissible variational/test field | $1$ |
| $g_i$ | assembled FEM DMI residual at node $i$ | $\mathrm{J}$ |
| $w_i^{\mathrm{lump}}$ | FEM lumped nodal integration weight | $\mathrm{m^3}$ |

(dmi-assumptions-and-validity)=
## Assumptions and validity limits

- Interfacial DMI is the thin-film invariant above, with one scalar $D_{\mathrm i}$ and one
  symmetry normal. Lower-symmetry Lifshitz tensors and multiple independent interfaces are not
  part of this public contract.
- Bulk DMI is the isotropic scalar invariant above. General anisotropic DMI tensors, atomistic
  exchange, and surface-only DMI are outside the current model.
- Both coefficients may be positive or negative. Their signs select chirality; replacing them by
  magnitudes changes the physical problem.
- The Python constructors require finite coefficients. A material spatial field is a FEM
  nodal-data route; it is not an arbitrary interpolation mechanism and is not currently an FDM
  per-cell material route.
- FDM uses centered differences. Active-neighbor and non-periodic missing-neighbor handling is a
  discrete closure in the current implementation, not a proof that the continuum natural DMI
  boundary law has been solved.
- FEM uses element/quadrature weak residuals and lumped-mass field projection. It is not the same
  operator as the FDM stencil.
- Construction and `ProblemIR` lowering are not runtime qualification. CUDA source presence is
  not executed-device parity evidence.

(dmi-python-api)=
## Python API

The primary execution workflow remains the public study/stage API. At the current revision the
stage builder has no dedicated DMI registration method, so the following boundary example is
valid stage authoring but does not silently claim to enable DMI:

```python
# %% Stage-first boundary: the stage API does not yet register DMI terms
import fullmag as fm

study = fm.study("dmi-stage-boundary")
study.engine("fdm")
study.cell(2e-9, 2e-9, 1e-9)
body = study.geometry(fm.Box(40e-9, 40e-9, 1e-9), name="film")
body.Ms = 8.0e5
body.Aex = 13e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_run(stage_id="run", until=2e-12)
```

For a DMI-enabled request, the current stage API has no registration hook. Inspect the DMI and
periodicity objects independently and treat the missing stage integration as an explicit API
boundary; do not fabricate a top-level simulation constructor:


### Complete parameter reference

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `InterfacialDMI.D` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite | interfacial coefficient and chirality sign | FDM/FEM CPU/GPU subject to lane policy | `energy_terms[].D` |
| `InterfacialDMI.interface_normal` | `Sequence[float] or None` | `None` | $1$ | length three and finite; non-zero for FEM; FDM accepts +z only | interfacial symmetry normal | FDM +z; FEM any non-zero normalized vector | `energy_terms[].interface_normal` when supplied |
| `BulkDMI.D` | `float` | required | $\mathrm{J\,m^{-2}}$ | finite; either sign | isotropic bulk coefficient and chirality sign | FDM/FEM CPU/GPU subject to lane policy | `energy_terms[].D` |
| `Material.Dind` | `float or None` | `None` | $\mathrm{J\,m^{-2}}$ | finite when supplied | material-owned scalar interfacial coefficient | FEM CPU/GPU; not an independent FDM scalar route | `materials[].interfacial_dmi` |
| `Material.Dbulk` | `float or None` | `None` | $\mathrm{J\,m^{-2}}$ | finite when supplied | material-owned scalar bulk coefficient | FEM CPU/GPU; FDM planner-dependent | `materials[].bulk_dmi` |
| `Material.Dind_field` | `list[float] or None` | `None` | $\mathrm{J\,m^{-2}}$ | finite values and resolved FEM node cardinality | spatial interfacial coefficient field | FEM CPU/GPU | `materials[].dind_field` |
| `Material.Dbulk_field` | `list[float] or None` | `None` | $\mathrm{J\,m^{-2}}$ | finite values and resolved FEM node cardinality | spatial bulk coefficient field | FEM CPU/GPU | `materials[].dbulk_field` |
| `FdmPbc.axes` | `tuple[bool,bool,bool]` | required | $1$ | exactly three booleans | periodic/open policy per Cartesian axis | FDM CPU/GPU | `pbc.axes` |
| `FdmPbc.demag` | `str` | `open` | $1$ | open, truncated_images, or periodic_airbox_k0 | demagnetization policy carried with the FDM request | FDM | `pbc.demag` |
| `FdmPbc.image_counts` | `tuple[int,int,int] or None` | `None` | $1$ | exactly three non-negative integers; only with truncated_images | finite image counts for the demag policy | FDM | `pbc.image_counts` |

The material parameters `name`, `Ms`, `A`, and `alpha` remain owned by the canonical Material
API page. They are shown in the executable example because $M_s$ and $A$ enter the resolved
field and natural-boundary semantics.

(dmi-problem-ir)=
## Python to ProblemIR

The explicit terms in the example lower to these interaction entries:

```json
{
  "energy_terms": [
    {
      "kind": "interfacial_dmi",
      "D": 0.0025,
      "interface_normal": [0.0, 0.0, 1.0]
    },
    {
      "kind": "bulk_dmi",
      "D": 0.003
    }
  ],
  "pbc": {
    "axes": ["periodic", "periodic", "periodic"],
    "demag": "open"
  }
}
```

`Problem.to_ir()` places the terms in `energy_terms`; it does not convert DMI into exchange,
anisotropy, demagnetization, or an external field. Material-owned coefficients lower to
`materials[].interfacial_dmi`, `materials[].bulk_dmi`, `materials[].dind_field`, and
`materials[].dbulk_field`. Explicit and material-owned routes are alternative coefficient
sources for a family and are not silently summed.

The resolved planner adds backend policy, normalized interface normal, coefficient location,
periodic restrictions, field availability, precision, and runtime provenance. Those resolved
values do not replace the requested Python intent.

(dmi-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The canonical chain is:

```text
Python DMI constructor or Material route
        ↓
ProblemIR.energy_terms / materials
        ↓
IR validation and duplicate/coefficient checks
        ↓
FDM or FEM planner resolution
        ↓
CPU/GPU field, energy, and observable realization
```

Requested intent preserves the DMI family, signed coefficient, explicit versus material route,
interface normal, spatial field values, and FDM periodicity request. Resolved execution records
the selected solver/device, normalized normal, material field route, precision, field/energy
availability, and qualification evidence.

Validation errors and unsupported combinations are fail-closed:

- a coefficient is non-finite;
- an interface normal is malformed, non-finite, or zero;
- an FDM interfacial normal is not the canonical +z direction;
- a material field has the wrong FEM node cardinality or non-finite values;
- explicit and material routes would create duplicate active family coefficients;
- bulk DMI is requested on a non-periodic or unsupported multilayer FDM plan;
- a required FEM mesh, MFEM context, lumped mass, or device buffer is missing;
- a requested observable is not materialized by the selected plan;
- a GPU request cannot satisfy its device/runtime contract.

These are unsupported combinations, not permission to silently rotate a stencil, change the sign
of $D$, fall back from FEM to FDM, or convert a non-periodic bulk request into a different model.

(dmi-discrete-realization)=
## Discrete realization by solver and device

| Solver | Device | Status | Implementation boundary |
|---|---|---|---|
| FDM | CPU | reference | Double-precision centered stencils, active-cell masking, and cell-volume energy reduction. |
| FDM | GPU | implemented | FP64/FP32 fused CUDA field paths and DMI energy reduction; source presence is not executed-device parity. |
| FEM | CPU | implemented | MFEM element/quadrature weak residual, material-field resolution, lumped-mass projection, and energy accumulation. |
| FEM | GPU | implemented | CUDA element residual and resident field/reduction paths; runtime device qualification remains separate. |

### FDM CPU

For a cell $i\in\mathcal A$, the interfacial +z field uses centered derivatives in the in-plane
directions:

```{math}
:label: eq-dmi-fdm-interfacial-field
\mathbf H_{\mathrm i,i}
=\frac{2D_{\mathrm i}}{\mu_0M_{s,i}}
\begin{bmatrix}
\delta_xm_z\\
\delta_ym_z\\
-(\delta_xm_x+\delta_ym_y)
\end{bmatrix}_i.
```

Bulk DMI uses the centered curl:

```{math}
:label: eq-dmi-fdm-bulk-field
\mathbf H_{\mathrm b,i}
=-\frac{2D_{\mathrm b}}{\mu_0M_{s,i}}
(\nabla_h\times\mathbf m)_i,
\qquad
(\nabla_h\times\mathbf m)_i=
\begin{bmatrix}
\delta_ym_z-\delta_zm_y\\
\delta_zm_x-\delta_xm_z\\
\delta_xm_y-\delta_ym_x
\end{bmatrix}_i.
```

The current CPU path substitutes the center value for inactive or missing non-periodic
neighbors. It skips inactive cells. The energy path multiplies the local density by
$V_i$ and sums over $\mathcal A$; it is not reconstructed from a projected field.

### FDM GPU

The CUDA FP64 and FP32 effective-field kernels consume the same interfacial +z stencil and bulk
curl semantics. The precision changes the arithmetic type and reduction round-off, not the
physical sign convention. DMI energy is reduced separately with the cell volume. A compiled
kernel, source map, or skipped GPU test is not evidence of executed-device parity; that requires
runtime identity and numerical comparison on the target device.

### FEM CPU

FEM evaluates the complete interfacial normal contraction and bulk curl in a weak residual. The
assembled residual $g_i$ is projected to the field by

```{math}
:label: eq-dmi-fem-lumped-projection
\mathbf H_{\mathrm{DMI},i}
=-\frac{\mathbf g_i}{\mu_0M_{s,i}w_i^{\mathrm{lump}}}.
```

The direct quadrature energy and the projected field are separate outputs. `Dind_field` and
`Dbulk_field` are resolved at FEM nodes/elements according to the native material-field path;
they do not turn the FDM lane into a spatial-material implementation. Missing positive lumped
mass or saturation values are errors.

### FEM GPU

The FEM GPU realization evaluates tetrahedral element residuals and energy contributions in CUDA,
uses device-resident magnetization/material/geometry buffers, and performs the same lumped field
projection contract. Atomic accumulation and reduction ordering may differ from FEM CPU. No CPU
fallback is implied when a device buffer, element data set, or required runtime capability is
missing.

(dmi-implementation-mapping)=
## Implementation mapping

| Layer | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python interfacial term | `packages/fullmag-py/src/fullmag/model/energy.py` | `class InterfacialDMI` | finite coefficient and optional normal | Python |
| Python bulk term | `packages/fullmag-py/src/fullmag/model/energy.py` | `class BulkDMI` | finite bulk coefficient | Python |
| Material routes | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | scalar and spatial DMI material fields | Python |
| FDM periodic policy | `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | periodic/open axis serialization | Python/IR |
| IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_dmi_energy_terms` | explicit DMI finite-value and normal checks | IR |
| Material IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_material_dmi_values` | finite scalar and spatial material values | IR |
| FDM planner | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM lane restrictions and DMI plan resolution | FDM |
| FEM planner | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM normal/material-field resolution | FEM |
| FDM interfacial field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `interfacial_dmi_field` | centered +z field | FDM CPU |
| FDM bulk field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `bulk_dmi_field` | centered curl field | FDM CPU |
| FDM GPU field | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | fused DMI field path | FDM GPU |
| FEM interfacial field | `backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp` | `compute_interfacial_dmi_field` | MFEM interfacial realization | FEM CPU |
| FEM bulk field | `backends/fem/cpu/mfem/interactions/dmi_bulk.cpp` | `compute_bulk_dmi_field` | MFEM bulk realization | FEM CPU |
| FEM weak interfacial residual | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_interfacial_residual` | element residual algebra | FEM CPU/GPU |
| FEM weak bulk residual | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_bulk_residual` | element residual algebra | FEM CPU/GPU |
| FEM field projection | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_project_lumped_field` | residual-to-field conversion | FEM CPU/GPU |
| FEM GPU element kernel | `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu` | `dmi_element_residual_kernel` | device residual and energy | FEM GPU |

(dmi-validation)=
## Validation and qualification

The interaction contract is validated at separate levels:

1. Python constructor and `ProblemIR` tests check finite values, normal shape, serialization,
   material-field data, and explicit/material route semantics.
2. FDM CPU tests compare allocating and in-place field paths, verify inactive-cell behavior,
   periodic centered derivatives, sign reversal under $D\mapsto-D$, and energy consistency.
3. FEM tests compare residual-derived fields with directional energy derivatives for both
   interfacial and bulk families, and validate positive $M_s$/lumped-mass failure behavior.
4. GPU source/contract tests check kernel dispatch and buffer ownership. They do not replace
   executed-device parity evidence.
5. A qualified CPU/GPU or FDM/FEM comparison must record the exact revision, mesh/grid, precision,
   runtime identity, observable definition, tolerance, and artifact provenance.

| Lane | Current evidence | Qualification boundary |
|---|---|---|
| FDM CPU | native centered field/energy routines and unit tests | reference lane; not a proof of FEM or CUDA parity |
| FDM GPU | FP64/FP32 CUDA field/reduction sources and contract checks | executed-device numerical parity still required |
| FEM CPU | MFEM field/residual/projection code and directional-derivative tests | native lane; application-level runtime qualification is separate |
| FEM GPU | CUDA element/RK field and energy paths | source presence is not device execution or parity evidence |

(dmi-limitations)=
## Limitations and deferred work

- FDM interfacial DMI currently supports only the canonical +z interface normal.
- FDM material spatial DMI fields are not a general executable per-cell material route.
- Bulk DMI on non-periodic or unsupported multilayer FDM plans is rejected rather than assigned a
  guessed natural boundary condition.
- No general anisotropic DMI tensor, multiple independent interface normals, atomistic DMI, or
  independently authored DMI boundary operator is exposed.
- GPU claims remain source-backed until an executed-device qualification artifact is attached.
- The public stage builder currently has no dedicated DMI registration hook; this page therefore
  does not publish a standalone Python constructor cell. A DMI example becomes publishable only
  when it can be expressed as a complete stage-first scenario.

(dmi-scientific-bibliography)=
## Scientific bibliography

1. I. E. Dzyaloshinskii, “A thermodynamic theory of ‘weak’ ferromagnetism of antiferromagnetics,”
   *Journal of Physics and Chemistry of Solids* **4**, 241 (1958),
   [doi:10.1016/0022-3697(58)90076-3](https://doi.org/10.1016/0022-3697(58)90076-3).
2. T. Moriya, “Anisotropic superexchange interaction and weak ferromagnetism,”
   *Physical Review* **120**, 91 (1960),
   [doi:10.1103/PhysRev.120.91](https://doi.org/10.1103/PhysRev.120.91).
3. S. Rohart and A. Thiaville, “Skyrmion confinement in ultrathin film nanostructures in the
   presence of Dzyaloshinskii–Moriya interaction,” *Physical Review B* **88**, 184422 (2013),
   [doi:10.1103/PhysRevB.88.184422](https://doi.org/10.1103/PhysRevB.88.184422).
4. A. N. Bogdanov and U. K. Rößler, “Chiral symmetry breaking in magnetic thin films and
   multilayers,” *Physical Review Letters* **87**, 037203 (2001),
   [doi:10.1103/PhysRevLett.87.037203](https://doi.org/10.1103/PhysRevLett.87.037203).

(dmi-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Interfacial Python constructor | `packages/fullmag-py/src/fullmag/model/energy.py` | `class InterfacialDMI` | explicit iDMI authoring and IR | Python |
| Bulk Python constructor | `packages/fullmag-py/src/fullmag/model/energy.py` | `class BulkDMI` | explicit bulk-DMI authoring and IR | Python |
| Material DMI routes | `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | scalar/spatial material coefficient fields | Python |
| FDM periodic request | `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | axis and demag policy serialization | Python/IR |
| Explicit IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_dmi_energy_terms` | finite D and normal validation | IR |
| Material IR validation | `crates/fullmag-ir/src/validation.rs` | `validate_material_dmi_values` | finite scalar/field validation | IR |
| FDM plan | `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM DMI support and restrictions | FDM |
| FEM plan | `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM normal and material-field resolution | FEM |
| FDM interfacial field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `interfacial_dmi_field` | +z centered stencil | FDM CPU |
| FDM bulk field | `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `bulk_dmi_field` | centered curl stencil | FDM CPU |
| FDM CUDA field | `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `combine_effective_field_fp64_kernel` | fused field assembly | FDM GPU |
| FEM interfacial field | `backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp` | `compute_interfacial_dmi_field` | native iDMI field | FEM CPU |
| FEM bulk field | `backends/fem/cpu/mfem/interactions/dmi_bulk.cpp` | `compute_bulk_dmi_field` | native bulk field | FEM CPU |
| FEM iDMI weak residual | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_interfacial_residual` | weak-form residual | FEM CPU/GPU |
| FEM bulk weak residual | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_accumulate_bulk_residual` | weak-form residual | FEM CPU/GPU |
| FEM field projection | `backends/fem/src/dmi_weak_residual.cpp` | `dmi_project_lumped_field` | lumped field projection | FEM CPU/GPU |
| FEM CUDA residual | `backends/fem/gpu/cuda/interactions/dmi/dmi_kernels.cu` | `dmi_element_residual_kernel` | element residual/energy kernel | FEM GPU |
