---
title: Cubic anisotropy
status: implemented
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

:::{admonition} Crystal-frame orthogonality validation
:class: note

Active cubic crystal axes must be finite, non-zero, and mutually orthogonal:

- At the **FEM planner boundary** (`validate_cubic_anisotropy_axes` in
  `crates/fullmag-plan/src/fem.rs`), `axis1` and `axis2` are normalized and checked against
  $\lvert \mathbf c_1 \cdot \mathbf c_2 \rvert \le 10^{-3}$ and
  $\lVert \mathbf c_1 \times \mathbf c_2 \rVert \ge 10^{-6}$ before native execution.
- Inside the **native FEM C++ realization** (`require_orthonormal_crystal_axes` in
  `backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp`), the resolved frame is verified to
  strict orthonormal tolerance $\lvert\lVert\mathbf c_a\rVert - 1\rvert \le 128\varepsilon_{\mathrm{mach}}$
  and $\lvert \mathbf c_1 \cdot \mathbf c_2 \rvert \le 128\varepsilon_{\mathrm{mach}}$
  ($\approx 2.84 \times 10^{-14}$). Authors should supply crystal axes orthogonal to at least
  $\lvert \mathbf c_1 \cdot \mathbf c_2 \rvert \le 10^{-6}$ (ideally machine precision).
- **FDM native field code** normalizes each axis and forms $\mathbf c_3 = \mathbf c_1 \times \mathbf c_2$
  without enforcing the FEM orthogonality tolerance, so FDM must not be reported as validating an
  arbitrary non-orthogonal crystal frame.
:::

## Solver and backend realizations

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | reference | Cell-local crystal-frame polynomial in double precision (`fields/anisotropy.rs`, `fields/energy.rs`) with cell-volume energy integration. |
| FDM | GPU | implemented | FP64/FP32 local field kernels and anisotropy energy reductions; precision paths remain separate. |
| FEM | CPU | implemented | Nodal/lumped and element-quadrature material paths with strict crystal-axis orthogonality validation. |
| FEM | GPU | implemented | Device `template <bool ComputeEnergy>` field/energy block kernels (`anisotropy_kernels.cu`) with explicit non-contracted FP64 arithmetic (`__dmul_rn`/`__dadd_rn`/`__dsub_rn`) for 0-ULP parity and single-launch fused `H_eff` (`fullmag_cuda_accumulate_heff_fused_xyz`); qualified on RTX 4080 SUPER. |

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

```{figure} /_static/diagrams/anisotropy-uniaxial-and-cubic-landscapes.svg
:alt: Two-panel anisotropy diagram highlighting panel (b) for Fullmag's cubic anisotropy polynomial w_c = Kc1 Sigma + Kc2 alpha_1^2 alpha_2^2 alpha_3^2 + Kc3 Sigma^2, showing 3D energy surfaces and (1-10)-plane cross-sections for Kc1 > 0 (<100> easy) and Kc1 < 0 (<111> easy), alongside uniaxial landscapes in panel (a).
:width: 100%
:name: fig-cubic-anisotropy-landscape
:figclass: fm-physics-figure

Panel (b) displays 3D isometric energy surfaces and $(1\bar{1}0)$-plane profiles for Fullmag's cubic polynomial with $K_{c1}>0$ ($\langle 100\rangle$ easy) and $K_{c1}<0$ ($\langle 111\rangle$ easy), highlighting FEM's strict orthonormal crystal-frame rule (Kittel 1949; Collings et al. 2023).
```

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

- `Kc1`, `Kc2`, and `Kc3` are SI energy-density constants in $\mathrm{J\,m^{-3}}$.
- The physical crystal frame is orthonormal ($\lvert \mathbf c_1 \cdot \mathbf c_2 \rvert \le 10^{-6}$
  recommended; FEM planner rejects $\lvert \mathbf c_1 \cdot \mathbf c_2 \rvert > 10^{-3}$ or
  $\lVert \mathbf c_1 \times \mathbf c_2 \rVert < 10^{-6}$, and native FEM C++ requires
  orthonormality within $128\varepsilon_{\mathrm{mach}}$). FDM normalization behavior must be
  recorded as resolved execution and not generalized to all lanes.
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
| `Material.Kc1` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical first cubic value | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc1` |
| `Material.Kc2` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical second cubic value | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc2` |
| `Material.Kc3` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical third cubic value | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc3` |
| `Material.anisC1` | `tuple[float,float,float] \| None` | `None` | $1$ | length 3; finite | first crystal axis | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_axis1` |
| `Material.anisC2` | `tuple[float,float,float] \| None` | `None` | $1$ | length 3; finite | second crystal axis | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_axis2` |
| `Material.Kc1_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite; cardinality downstream | spatial Kc1 override | FEM and supported allocating FDM reference paths | `materials[].kc1_field` |
| `Material.Kc2_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite; cardinality downstream | spatial Kc2 override | FEM and supported allocating FDM reference paths | `materials[].kc2_field` |
| `Material.Kc3_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite; cardinality downstream | spatial Kc3 override | FEM and supported allocating FDM reference paths | `materials[].kc3_field` |

### Executable user workflow: study and stages

The normal user-facing script assigns the cubic constants and crystal axes directly on the
geometry handle (`MagnetHandle`), then registers an explicit stage pipeline. This example
exercises the FDM CPU reference lane; device and precision are resolved from the declared study
intent.

```python
# %% Copyable Python/Jupyter example: cubic anisotropy study pipeline
import fullmag as fm

nm = 1.0e-9
study = fm.study("cubic-anisotropy-example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.exchange()
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 1 * nm))

body = study.geometry(fm.Box(40 * nm, 20 * nm, 5 * nm), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.01
body.Kc1 = 0.2e6
body.Kc2 = 0.0
body.Kc3 = 0.0
body.anisC1 = (1.0, 0.0, 0.0)
body.anisC2 = (0.0, 1.0, 0.0)
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.stages.add_relax(
    stage_id="relax",
    algorithm="nonlinear_cg",
    max_steps=50_000,
    tolT=1.0e-6,
)
```

On the stage-first handle (`MagnetHandle` in `packages/fullmag-py/src/fullmag/world.py`),
`body.Kc1`, `body.Kc2`, `body.Kc3`, `body.anisC1`, and `body.anisC2` are all exposed directly.
Spatial `Kc1_field`, `Kc2_field`, and `Kc3_field` arrays are authored on `fm.Material(...)`.
A GPU request or spatial cubic fields requires the corresponding planner capability and is not
implied by this CPU reference example.

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

The compatibility term is migrated to one material. FEM planning rejects non-finite, zero-norm,
or non-orthogonal active axes (`validate_cubic_anisotropy_axes`). The planner must preserve
requested intent and resolved execution; it must not silently repair an invalid crystal frame
while reporting a successful physical run.

(cubic-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the Python term/material. Resolved execution records the canonical material
fields, normalized/validated crystal frame, solver, device, precision, material-field realization,
and output legality. Validation errors include wrong vector shape, non-finite axes/constants,
legacy/material conflicts, multi-material migration, and invalid FEM crystal frames. Unsupported combinations are planner errors, not silent fallbacks.

(cubic-discrete-realization)=
## Discrete realization

### FDM CPU

Each active cell (`crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs`,
`crates/fullmag-engine/src/fdm/cpu/fields/energy.rs`) computes $\alpha_a$ in the derived frame
and integrates

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

FEM uses strict orthonormal axes (`require_orthonormal_crystal_axes`). Scalar fields use
nodal/lumped integration; spatial material fields use element quadrature with explicit field
cardinality and material-location checks.

### FEM GPU

`cubic_anisotropy_field_energy_blocks_kernel<ComputeEnergy>` computes the crystal-frame
components, reconstructs the laboratory field using explicit non-contracted IEEE-754 FP64
intrinsics (`__dmul_rn`, `__dadd_rn`, `__dsub_rn`) so `ComputeEnergy=true` and
`ComputeEnergy=false` emit 0-ULP bitwise-identical `H_cubic` under NVCC `-fmad=true`, gates
per-block `cub::BlockReduce` energy reductions on `block_sums != nullptr` (skipping unused
intermediate RK reductions), and feeds `fullmag_cuda_accumulate_heff_fused_xyz` (`17.5×` faster
single-launch fused `H_eff`). Device `Ms`, `Kc` arrays, axes, masks, and lumped masses are
required; missing arrays fail closed. See {ref}`numerical-methods-performance-fem-gpu-kernels`.

### Observables

| Observable | Kind | SI unit | Availability |
|---|---|---|---|
| `H_ani_cubic` | vector field | $\mathrm{A\,m^{-1}}$ | Active cubic anisotropy and field materialization. |
| `E_ani` | scalar | $\mathrm{J}$ | Active anisotropy and scalar energy materialization. |
| `eden_ani` | spatial scalar field | $\mathrm{J\,m^{-3}}$ | Active anisotropy and spatial-energy materialization. |

(cubic-implementation-mapping)=
## Implementation mapping

Python migration and material serialization are separate from native plan resolution. FDM CPU,
FDM CUDA, FEM CPU, and FEM CUDA have separate field and energy symbols listed in the source-code index below.

(cubic-validation)=
## Validation and qualification

Use the six high-symmetry directions of the cubic frame and compare the polynomial energy. Perturb
each direction and compare finite differences with the analytic crystal-frame field. Test invalid
axis norms/dot products in FEM planning, scalar and spatial Kc fields, inactive masks, and all
precision lanes. Compare field, scalar energy, and spatial energy, not only trajectories. On FEM
GPU (RTX 4080 SUPER, SM `89-real`), `fem_cuda_shortrange_kernels_contract` verifies 0-ULP bitwise
field equality (`memcmp == 0`) between `ComputeEnergy=true` and `ComputeEnergy=false` with 0
`compute-sanitizer` errors and `ΔE_ani = 0.0` across 50 RK4 steps.

(cubic-limitations)=
## Limitations and deferred work

The public frame is specified by two axes. No arbitrary third axis parameter or public per-node
crystal-frame field exists. FEM strict orthonormal validation and FDM normalization behavior must
remain explicitly distinguished. FDM GPU production qualification remains an executed-device
question.

(cubic-scientific-bibliography)=
## Scientific bibliography

1. C. Kittel, “Physical Theory of Ferromagnetic Domains,” *Reviews of Modern Physics* **21**(4), 541–583 (1949). [doi:10.1103/RevModPhys.21.541](https://doi.org/10.1103/RevModPhys.21.541).
2. J. B. Collings, R. Rama-Eiroa, R. M. Otxoa, R. F. L. Evans, and R. W. Chantrell, “Generalized form of the magnetic anisotropy field in micromagnetic and atomistic spin models,” *Physical Review B* **107**(6), 064413 (2023). [doi:10.1103/PhysRevB.107.064413](https://doi.org/10.1103/PhysRevB.107.064413) | [Open-access PDF (White Rose)](https://eprints.whiterose.ac.uk/id/eprint/197787/1/PhysRevB.107.064413.pdf) | [arXiv:2210.10916](https://arxiv.org/abs/2210.10916).
3. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers / Wiley, New York (1963). [WorldCat record](https://search.worldcat.org/title/536451).

(cubic-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L556) | [`class CubicAnisotropy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L556) | Compatibility constructor and serialization. |
| [`packages/fullmag-py/src/fullmag/model/structure.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L16) | [`class Material`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L16) | Canonical cubic constants, axes, and fields. |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L568) | [`class MagnetHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L568) | Stage-first direct `Kc1`, `Kc2`, `Kc3`, `anisC1`, and `anisC2` authoring. |
| [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2197) | [`_migrate_legacy_anisotropy_energy_terms`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2197) | Conflict-checked migration. |
| [`crates/fullmag-plan/src/fdm.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fdm.rs#L2512) | [`plan_fdm`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fdm.rs#L2512) | FDM native cubic material resolution. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L4287) | [`plan_fem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L4287) | FEM native resolution. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L3655) | [`validate_cubic_anisotropy_axes`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L3655) | FEM planner cubic axis orthogonality check. |
| [`crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs#L65) | [`anisotropy_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs#L65) | FDM CPU cubic field composition. |
| [`crates/fullmag-engine/src/fdm/cpu/fields/energy.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/energy.rs#L502) | [`anisotropy_energy_density_from_vectors`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/energy.rs#L502) | FDM CPU cubic energy density. |
| [`backends/fdm/gpu/cuda/interactions/demag_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L574) | [`anisotropy_field_fp64_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L574) | FDM CUDA FP64 local anisotropy field. |
| [`backends/fdm/gpu/cuda/interactions/demag_fp32.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp32.cu#L546) | [`anisotropy_field_fp32_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp32.cu#L546) | FDM CUDA FP32 local anisotropy field. |
| [`backends/fdm/gpu/cuda/runtime/reductions_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L1763) | [`reduce_cubic_anisotropy_energy_fp64`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/reductions_fp64.cu#L1763) | FDM CUDA cubic energy reduction. |
| [`backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp#L127) | [`compute_cubic_anisotropy_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp#L127) | FEM CPU field and lumped energy. |
| [`backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp#L216) | [`cubic_anisotropy_energy_from_element_quadrature_material`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp#L216) | FEM CPU spatial-material energy. |
| [`backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu#L91) | [`cubic_anisotropy_field_energy_blocks_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu#L91) | FEM CUDA cubic field/energy blocks with non-contracted FP64 parity. |
| [`backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_field.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_field.cu#L38) | [`gpu_rk_compute_anisotropy_field_contributions`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_field.cu#L38) | FEM CUDA field dispatch and buffer validation. |
| [`backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu#L41) | [`gpu_rk_reduce_final_anisotropy_energy_terms`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.cu#L41) | FEM CUDA final energy reduction. |
| [`backends/fem/gpu/cuda/fields/vector_field_kernels.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/fields/vector_field_kernels.hpp#L91) | [`fullmag_cuda_accumulate_heff_fused_xyz`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/fields/vector_field_kernels.hpp#L91) | FEM CUDA single-launch fused `H_eff` composition. |
