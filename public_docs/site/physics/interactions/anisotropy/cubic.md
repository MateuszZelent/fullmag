---
title: Cubic anisotropy
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0403-cubic-anisotropy.md
---

(public-docs-physics-interactions-anisotropy-cubic)=
# Cubic magnetocrystalline anisotropy

Cubic anisotropy couples the reduced magnetization to a crystal frame. FullMag implements three
energy-density constants, `Kc1`, `Kc2`, and `Kc3`, and two user-supplied crystal axes. The third
axis is derived as $\mathbf c_3=\mathbf c_1\times\mathbf c_2$.

The public compatibility object `fullmag.CubicAnisotropy` is migrated into canonical material
fields before ProblemIR lowering. It is not a second native energy owner. The API and migration
contract are documented in {doc}`../../../python-api/interactions/cubic-anisotropy`.

:::{admonition} Crystal-frame validity
:class: note

FEM planning requires finite unit orthogonal `axis1` and `axis2`. FDM native field code
normalizes each axis and derives a cross product; it must not be reported as accepting an
arbitrary non-orthogonal physical crystal frame without a lane-specific validation result.
:::

## Solver and backend realizations

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | reference | Cell-local crystal-frame polynomial in double precision with cell-volume energy integration. |
| FDM | GPU | implemented | FP64/FP32 local field kernels and anisotropy energy reductions; precision paths remain separate. |
| FEM | CPU | implemented | Nodal/lumped and element-quadrature material paths with strict crystal-axis validation. |
| FEM | GPU | implemented | Device field/energy block kernels and reductions; current executed-device qualification is separate. |

(cubic-problem-statement)=
## Physical problem

Let $\mathbf c_1$ and $\mathbf c_2$ be orthonormal crystal axes and define

```{math}
:label: eq-cubic-crystal-frame
\mathbf c_3=\mathbf c_1\times\mathbf c_2,
\qquad
\alpha_a=\mathbf m\cdot\mathbf c_a,
\qquad a\in\{1,2,3\}.
```

For a normalized magnetization and an orthonormal frame, the $\alpha_a$ are direction cosines and
$\alpha_1^2+\alpha_2^2+\alpha_3^2=1$. This identity is a physical frame property, not a license
to omit axis validation.

(cubic-governing-equations)=
## Governing equations

Define the cubic invariant

```{math}
:label: eq-cubic-invariant
\Sigma=\alpha_1^2\alpha_2^2+\alpha_2^2\alpha_3^2+\alpha_3^2\alpha_1^2.
```

The implemented density and total energy are

```{math}
:label: eq-cubic-energy
w_{\mathrm c}=K_{c1}\Sigma+K_{c2}\alpha_1^2\alpha_2^2\alpha_3^2+K_{c3}\Sigma^2,
\qquad
E_{\mathrm c}=\int_{\Omega_m}w_{\mathrm c}\,\mathrm dV.
```

The crystal-frame derivatives used to construct the effective field are

```{math}
:label: eq-cubic-field-components
\begin{aligned}
g_1&=-\frac{2}{\mu_0M_s}\left[
K_{c1}\alpha_1(\alpha_2^2+\alpha_3^2)
+K_{c2}\alpha_1\alpha_2^2\alpha_3^2
+2K_{c3}\Sigma\alpha_1(\alpha_2^2+\alpha_3^2)\right],\\
g_2&=-\frac{2}{\mu_0M_s}\left[
K_{c1}\alpha_2(\alpha_1^2+\alpha_3^2)
+K_{c2}\alpha_2\alpha_1^2\alpha_3^2
+2K_{c3}\Sigma\alpha_2(\alpha_1^2+\alpha_3^2)\right],\\
g_3&=-\frac{2}{\mu_0M_s}\left[
K_{c1}\alpha_3(\alpha_1^2+\alpha_2^2)
+K_{c2}\alpha_3\alpha_1^2\alpha_2^2
+2K_{c3}\Sigma\alpha_3(\alpha_1^2+\alpha_2^2)\right].
\end{aligned}
```

The effective field is reconstructed in the laboratory frame:

```{math}
:label: eq-cubic-effective-field
\mathbf H_{\mathrm c}=g_1\mathbf c_1+g_2\mathbf c_2+g_3\mathbf c_3.
```

The minus sign follows the FullMag convention
$\mathbf H=-\frac{1}{\mu_0M_s}\frac{\delta E}{\delta\mathbf m}$. The field is local and does
not require a demagnetization solve or an interaction boundary condition.

(cubic-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $\mathbf c_1$ | first crystal axis | $1$ |
| $\mathbf c_2$ | second crystal axis | $1$ |
| $\mathbf c_3$ | derived third crystal axis $\mathbf c_1\times\mathbf c_2$ | $1$ |
| $\alpha_a$ | direction cosine $\mathbf m\cdot\mathbf c_a$ | $1$ |
| $\Sigma$ | first cubic invariant | $1$ |
| $K_{c1}$ | first cubic anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $K_{c2}$ | second cubic anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $K_{c3}$ | third cubic anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $g_a$ | crystal-frame effective-field component | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm c}$ | cubic anisotropy effective field | $\mathrm{A\,m^{-1}}$ |
| $w_{\mathrm c}$ | local cubic anisotropy energy density | $\mathrm{J\,m^{-3}}$ |
| $E_{\mathrm c}$ | total cubic anisotropy energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic integration domain | $\mathrm{m^3}$ |
| $i$ | discrete cell or node index | $1$ |
| $V_i$ | FDM cell volume | $\mathrm{m^3}$ |
| $w_i^{\mathrm{lump}}$ | FEM nodal lumped integration weight | $\mathrm{m^3}$ |

(cubic-assumptions-and-validity)=
## Assumptions and validity

- `Kc1`, `Kc2`, and `Kc3` are SI energy-density constants in J/m^3.
- The physical crystal frame is orthonormal. FEM planner validation is strict; FDM normalization
  behavior must be recorded as resolved execution and not generalized to all lanes.
- $M_s>0$ and the reduced magnetization normalization are supplied by surrounding contracts.
- Spatial `Kc1_field`, `Kc2_field`, and `Kc3_field` require backend-supported cardinality and
  interpolation; they do not change the crystal axes.
- Constants may be positive or negative at the public validation layer; the resulting anisotropy
  landscape, easy directions, and stability must be analyzed rather than inferred from `Kc1`
  alone.

(cubic-python-api)=
## Python authoring and canonical ProblemIR

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `CubicAnisotropy.kc1` | `float` | `required` | $\mathrm{J\,m^{-3}}$ | finite | first cubic constant | FDM/FEM CPU/GPU after migration | `materials[].cubic_anisotropy_kc1` |
| `CubicAnisotropy.kc2` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | finite | second cubic constant | FDM/FEM CPU/GPU after migration | `materials[].cubic_anisotropy_kc2` |
| `CubicAnisotropy.kc3` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | finite | third cubic constant | FDM/FEM CPU/GPU after migration | `materials[].cubic_anisotropy_kc3` |
| `CubicAnisotropy.axis1` | `Sequence[float]` | `(1,0,0)` | $1$ | length 3; finite | first crystal axis | FDM/FEM CPU/GPU after migration | `materials[].cubic_anisotropy_axis1` |
| `CubicAnisotropy.axis2` | `Sequence[float]` | `(0,1,0)` | $1$ | length 3; finite | second crystal axis | FDM/FEM CPU/GPU after migration | `materials[].cubic_anisotropy_axis2` |
| `Material.Kc1` | `float \\| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical first cubic value | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc1` |
| `Material.Kc2` | `float \\| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical second cubic value | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc2` |
| `Material.Kc3` | `float \\| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical third cubic value | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc3` |
| `Material.anisC1` | `tuple[float,float,float] \\| None` | `None` | $1$ | length 3; finite | first crystal axis | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_axis1` |
| `Material.anisC2` | `tuple[float,float,float] \\| None` | `None` | $1$ | length 3; finite | second crystal axis | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_axis2` |
| `Material.Kc1_field` | `list[float] \\| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite; cardinality downstream | spatial Kc1 override | FEM and supported allocating FDM reference paths | `materials[].kc1_field` |
| `Material.Kc2_field` | `list[float] \\| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite; cardinality downstream | spatial Kc2 override | FEM and supported allocating FDM reference paths | `materials[].kc2_field` |
| `Material.Kc3_field` | `list[float] \\| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite; cardinality downstream | spatial Kc3 override | FEM and supported allocating FDM reference paths | `materials[].kc3_field` |


### Executable user workflow: study and stages

The normal user-facing script assigns the cubic constants and crystal axes to the geometry
material, then registers an explicit stage pipeline. This example exercises the FDM CPU reference
lane; device and precision are resolved from the declared study intent.

```python
# %% Copyable Python/Jupyter example: cubic anisotropy study pipeline
import fullmag as fm

nm = 1.0e-9
study = fm.study("cubic-anisotropy-example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.exchange()
study.cell(2 * nm, 2 * nm, 1 * nm)

body = study.geometry(fm.Box(40 * nm, 20 * nm, 5 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.01
body.Kc1 = 0.2e6
body.Kc2 = 0.0
body.Kc3 = 0.0
body.anisC1 = (1.0, 0.0, 0.0)
body.anisC2 = (0.0, 1.0, 0.0)
body.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=50_000,
    tolT=1.0e-6,
)
```

The compatibility constructor `fm.CubicAnisotropy` is a lowering/inspection form; the stage
workflow above is the public simulation authoring path. A GPU request or spatial cubic fields
requires the corresponding planner capability and is not implied by this CPU reference example.

(cubic-problem-ir)=
## ProblemIR and planner contract

The canonical material fragment is:

```json
{
  "cubic_anisotropy_kc1": 200000.0,
  "cubic_anisotropy_kc2": 0.0,
  "cubic_anisotropy_kc3": 0.0,
  "cubic_anisotropy_axis1": [1.0, 0.0, 0.0],
  "cubic_anisotropy_axis2": [0.0, 1.0, 0.0]
}
```

The compatibility term is migrated to one material. FEM planning rejects non-finite, non-unit,
or non-orthogonal active axes. The planner must preserve requested intent and resolved execution;
it must not silently repair an invalid crystal frame while reporting a successful physical run.

(cubic-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the Python term/material. Resolved execution records the canonical material
fields, normalized/validated crystal frame, solver, device, precision, material-field realization,
and output legality. Validation errors include wrong vector shape, non-finite axes/constants,
legacy/material conflicts, multi-material migration, and invalid FEM crystal frames. Unsupported combinations are planner errors, not silent fallbacks.

(cubic-discrete-realization)=
## Discrete realization

### FDM CPU

Each active cell computes $\alpha_a$ in the derived frame and integrates

```{math}
:label: eq-cubic-fdm-energy
E_{\mathrm c}^{\mathrm{FDM}}
=
\sum_i\left(K_{c1,i}\Sigma_i+K_{c2,i}\alpha_{1,i}^2\alpha_{2,i}^2\alpha_{3,i}^2+K_{c3,i}\Sigma_i^2\right)V_i.
```

The local field is added to `H_eff`; inactive cells contribute zero.

### FDM GPU

CUDA FP64/FP32 local kernels and energy reductions use the same polynomial with precision-specific
arithmetic. A device source path is not an executed-device parity result.

### FEM CPU

FEM uses strict orthonormal axes. Scalar fields use nodal/lumped integration; spatial material
fields use element quadrature with explicit field cardinality and material-location checks.

### FEM GPU

The CUDA kernel computes the crystal-frame components, reconstructs the laboratory field, emits
block energy sums, and the RK reduction consumes those sums. Device `Ms`, Kc arrays, axes, masks,
and lumped masses are required; missing arrays fail closed.

### Observables

| Observable | Kind | SI unit | Availability |
|---|---|---|---|
| `H_ani_cubic` | vector field | $\mathrm{A\,m^{-1}}$ | Active cubic anisotropy and field materialization. |
| `E_ani` | scalar | $\mathrm{J}$ | Active anisotropy and scalar energy materialization. |
| `eden_ani` | spatial scalar field | $\mathrm{J\,m^{-3}}$ | Active anisotropy and spatial-energy materialization. |

(cubic-implementation-mapping)=
## Implementation mapping

Python migration and material serialization are separate from native plan resolution. FDM CPU,
FDM CUDA, FEM CPU, and FEM CUDA have separate field/energy symbols listed in the source index and
machine map. Stable symbols, not stale line numbers, are the citation identity.

(cubic-validation)=
## Validation and qualification

Use the six high-symmetry directions of the cubic frame and compare the polynomial energy. Perturb
each direction and compare finite differences with the analytic crystal-frame field. Test invalid
axis norms/dot products in FEM planning, scalar and spatial Kc fields, inactive masks, and all
precision lanes. Compare field, scalar energy, and spatial energy, not only trajectories.

(cubic-limitations)=
## Limitations and deferred work

The public frame is specified by two axes. No arbitrary third axis parameter or public per-node
crystal-frame field exists. FEM strict orthonormal validation and FDM normalization behavior must
remain explicitly distinguished. GPU production qualification remains an executed-device question.

(cubic-scientific-bibliography)=
## Scientific bibliography

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- FullMag internal source of truth: `docs/physics/0403-cubic-anisotropy.md`.
- FullMag implementation: `packages/fullmag-py/src/fullmag/model/energy.py` and `structure.py`.

(cubic-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class CubicAnisotropy` | Compatibility constructor and serialization. |
| `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | Canonical cubic constants, axes, and fields. |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `_migrate_legacy_anisotropy_energy_terms` | Conflict-checked migration. |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM native cubic material resolution. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM native resolution and strict axis validation. |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `anisotropy_field` | FDM CPU cubic field composition. |
| `crates/fullmag-engine/src/fdm/cpu/fields.rs` | `anisotropy_energy_density_from_vectors` | FDM CPU cubic energy density. |
| `backends/fdm/gpu/cuda/interactions/demag_fp64.cu` | `anisotropy_field_fp64_kernel` | FDM CUDA FP64 local anisotropy field. |
| `backends/fdm/gpu/cuda/interactions/demag_fp32.cu` | `anisotropy_field_fp32_kernel` | FDM CUDA FP32 local anisotropy field. |
| `backends/fdm/gpu/cuda/runtime/reductions_fp64.cu` | `reduce_cubic_anisotropy_energy_fp64` | FDM CUDA cubic energy reduction. |
| `backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp` | `compute_cubic_anisotropy_field` | FEM CPU field and lumped energy. |
| `backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp` | `cubic_anisotropy_energy_from_element_quadrature_material` | FEM CPU spatial-material energy. |
| `backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu` | `cubic_anisotropy_field_energy_blocks_kernel` | FEM CUDA cubic field/energy blocks. |
| `backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_field.cu` | `gpu_rk_compute_anisotropy_field_contributions` | FEM CUDA field dispatch and buffer validation. |
| `backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu` | `gpu_rk_reduce_final_anisotropy_energy_terms` | FEM CUDA final energy reduction. |
