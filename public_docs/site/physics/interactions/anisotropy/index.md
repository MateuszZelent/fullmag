---
title: Anisotropy
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-anisotropy-root)=
# Anisotropy

Fullmag supports uniaxial and cubic local magnetocrystalline anisotropy. The absolute energy
convention matters because Fullmag reports scalar energies, not only effective fields.

```{toctree}
:maxdepth: 1

uniaxial
cubic
```

(physics-anisotropy-problem-statement)=
## Physical problem

Magnetocrystalline anisotropy adds an orientation-dependent energy density whose minimum aligns the magnetization with preferred crystal axes (`uniaxial` or `cubic` symmetry). This overview connects the continuum anisotropy energy and effective field to Fullmag's material-owned authoring, `ProblemIR` serialization, planner resolution, and executable backend lanes.

(physics-anisotropy-governing-equations)=
## Governing equations

Let $q=\mathbf m\cdot\hat{\mathbf u}$. The **implemented Fullmag convention** is

```{math}
:label: eq-public-anisotropy-anisotropy-uniaxial-energy
w_{\mathrm u}=-K_{u1}q^2-K_{u2}q^4 .
```

```{math}
:label: eq-public-anisotropy-anisotropy-uniaxial-field
\mathbf H_{\mathrm u}
=
\frac{2K_{u1}q+4K_{u2}q^3}{\mu_0M_s}\hat{\mathbf u}.
```

This is not parameter-identical to writing
$\tilde K_{u1}\sin^2\theta+\tilde K_{u2}\sin^4\theta$: converting from the $\sin^2/\sin^4$
parameterization to Fullmag's convention requires $K_{u1}=\tilde K_{u1}+2\tilde K_{u2}$ and
$K_{u2}=-\tilde K_{u2}$ (plus the constant energy shift $\tilde K_{u1}+\tilde K_{u2}$).
See {doc}`uniaxial` for the easy-cone stability condition and exact transformation.

For an orthonormal crystal frame
$(\hat{\mathbf c}_1,\hat{\mathbf c}_2,\hat{\mathbf c}_3)$, let
$\alpha_i=\mathbf m\cdot\hat{\mathbf c}_i$ and

```{math}
:label: eq-public-anisotropy-anisotropy-cubic-invariant
P=\alpha_1^2\alpha_2^2+\alpha_2^2\alpha_3^2+\alpha_3^2\alpha_1^2 .
```

The implemented cubic polynomial is

```{math}
:label: eq-public-anisotropy-anisotropy-cubic-energy
w_{\mathrm c}
=
K_{c1}P
+K_{c2}\alpha_1^2\alpha_2^2\alpha_3^2
+K_{c3}P^2 .
```

Because higher-order cubic conventions differ between codes and publications, $K_{c2}$ and
$K_{c3}$ must always be interpreted together with this equation.

```{figure} /_static/diagrams/anisotropy-uniaxial-and-cubic-landscapes.svg
:alt: Two-panel diagram showing (a) uniaxial polar excess energy curves for easy axis, easy plane, and easy cone regimes plus the constant energy offset between Fullmag's -K_u1 cos^2(theta) and K_u1 sin^2(theta) conventions, and (b) 3D cubic energy landscapes and (1-10)-plane cross-sections for Kc1 > 0 (<100> easy) and Kc1 < 0 (<111> easy).
:width: 100%
:name: fig-anisotropy-uniaxial-and-cubic-landscapes
:figclass: fm-physics-figure

Uniaxial energy regimes and scalar convention offset against $\sin^2\theta$ forms (a), paired with 3D cubic energy surfaces and $(1\bar{1}0)$-plane profiles for $K_{c1}>0$ and $K_{c1}<0$ (b) (Stoner & Wohlfarth 1948; Kittel 1949; Collings et al. 2023).
```

(physics-anisotropy-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $K_{u1}$ | first-order uniaxial anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $K_{u2}$ | second-order uniaxial anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $K_{c1}$ | first-order cubic anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $K_{c2}$ | second-order cubic anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $K_{c3}$ | third-order cubic anisotropy constant | $\mathrm{J\,m^{-3}}$ |
| $\hat{\mathbf u}$ | normalized uniaxial easy axis | $1$ |
| $\hat{\mathbf c}_i$ | orthonormal crystal axes | $1$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $q$ | uniaxial direction cosine $\mathbf m\cdot\hat{\mathbf u}$ | $1$ |
| $\alpha_i$ | cubic direction cosine $\mathbf m\cdot\hat{\mathbf c}_i$ | $1$ |
| $P$ | fourth-order cubic invariant | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $w_{\mathrm u}$ | uniaxial anisotropy energy density | $\mathrm{J\,m^{-3}}$ |
| $w_{\mathrm c}$ | cubic anisotropy energy density | $\mathrm{J\,m^{-3}}$ |
| $\mathbf H_{\mathrm u}$ | uniaxial anisotropy effective field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm c}$ | cubic anisotropy effective field | $\mathrm{A\,m^{-1}}$ |

(physics-anisotropy-assumptions-and-validity)=
## Assumptions and validity

Anisotropy is local and has no independent boundary condition. Active axes must be finite and
non-zero; cubic axes must define an orthonormal right-handed crystal frame validated by the
planner and native FEM checks (see {doc}`cubic`). Spatial coefficient fields (`Ku_field`,
`Ku2_field`, `Kc1_field`, `Kc2_field`, `Kc3_field`) are mesh-associated data and must match
the realized cell or node cardinality.

(physics-anisotropy-discrete-realization)=
## Backend capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | `MagnetHandle` / `Material` and compatibility constructors | reference executable (`fields/anisotropy.rs`, `fields/energy.rs`) | analytic and finite-difference oracles | cell-local field and volume energy sum |
| FDM | GPU | same canonical material IR | implemented FP64/FP32 local and multilayer CUDA kernels | FP32/FP64 qualification separate | device masks and scalar/regional coefficient arrays |
| FEM | CPU | same canonical material IR | implemented nodal/lumped and element-quadrature paths | mesh/integration and strict orthonormal-axis checks | nodal/element realization with strict crystal-frame validation |
| FEM | GPU | same canonical material IR | device-resident `template <bool ComputeEnergy>` block kernels (`anisotropy_kernels.cu`) + single-launch fused `H_eff` (`fullmag_cuda_accumulate_heff_fused_xyz`) | RTX 4080 SUPER qualified (`fem_cuda_shortrange_kernels_contract`, 0 memcheck errors, 0-ULP cubic FP64 parity, `ΔE_ani = 0.0` over 50 RK4 steps) | strict device-resident FP64; no silent CPU fallback |

See {ref}`numerical-methods-performance-fem-gpu-kernels` for FEM GPU intermediate RK reduction
gating, cubic FP64 non-contracted parity, and fused `H_eff` benchmarks.

(physics-anisotropy-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("anisotropy_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %% Direct stage-first uniaxial and cubic anisotropy authoring on MagnetHandle
body.Ku1 = 5.0e5
body.Ku2 = 5.0e4
body.anisU = (0.0, 0.0, 1.0)
body.Kc1 = 4.8e4
body.Kc2 = 0.0
body.Kc3 = 0.0
body.anisC1 = (1.0, 0.0, 0.0)
body.anisC2 = (0.0, 1.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=500, tolT=1.0e-6)
```

On the stage-first handle (`MagnetHandle` in `packages/fullmag-py/src/fullmag/world.py`),
`body.Ku1`, `body.Ku2`, `body.anisU`, `body.Kc1`, `body.Kc2`, `body.Kc3`, `body.anisC1`, and
`body.anisC2` are all exposed directly and lower to canonical material fields. Spatial nodal/cell
override arrays (`Ku_field`, `Ku2_field`, `Kc1_field`, `Kc2_field`, `Kc3_field`) are authored on
`fm.Material(...)`. `fm.UniaxialAnisotropy` and `fm.CubicAnisotropy` remain supported
compatibility constructors migrated into canonical material fields before `ProblemIR` lowering.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Material.Ku1` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | first-order uniaxial constant | FDM/FEM CPU/GPU | `materials[].uniaxial_anisotropy` |
| `Material.Ku2` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | second-order uniaxial constant | FDM/FEM CPU/GPU | `materials[].uniaxial_anisotropy_k2` |
| `Material.anisU` | `tuple[float,float,float] \| None` | `None` | $1$ | length 3; finite; non-zero when active | uniaxial easy axis | FDM/FEM CPU/GPU | `materials[].anisotropy_axis` |
| `Material.Kc1` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | first cubic constant | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc1` |
| `Material.Kc2` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | second cubic constant | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc2` |
| `Material.Kc3` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | third cubic constant | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_kc3` |
| `Material.anisC1` | `tuple[float,float,float] \| None` | `None` | $1$ | length 3; finite; orthonormal with `anisC2` | first cubic crystal axis | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_axis1` |
| `Material.anisC2` | `tuple[float,float,float] \| None` | `None` | $1$ | length 3; finite; orthonormal with `anisC1` | second cubic crystal axis | FDM/FEM CPU/GPU | `materials[].cubic_anisotropy_axis2` |

(physics-anisotropy-problem-ir)=
## ProblemIR

Representative material fragment:

```json
{
  "uniaxial_anisotropy": 500000.0,
  "uniaxial_anisotropy_k2": 50000.0,
  "anisotropy_axis": [0.0, 0.0, 1.0],
  "cubic_anisotropy_kc1": 48000.0,
  "cubic_anisotropy_kc2": 0.0,
  "cubic_anisotropy_kc3": 0.0,
  "cubic_anisotropy_axis1": [1.0, 0.0, 0.0],
  "cubic_anisotropy_axis2": [0.0, 1.0, 0.0]
}
```

(physics-anisotropy-validation)=
## Validation boundary

Compatibility constructors convert constants with `float()` and axes with `as_vector3`, leaving finite and non-zero/orthogonality checks for downstream validation rather than constructor time. On `Material`, `Material.Ku1` and `Material.Ku2` are finite-checked at construction, whereas the cubic material constants and crystal-frame orthogonality are enforced during lowering, planning (`validate_cubic_anisotropy_axes`), and native FEM checks (`require_orthonormal_crystal_axes`).

Note that the implemented uniaxial convention follows $-K_{u1}q^2-K_{u2}q^4$ rather than a $\sin^2/\sin^4$ parameterization; see {doc}`uniaxial` for the exact signs, easy-cone condition, and transformation.

## Required numerical validation

- energy minima/maxima for easy-axis, easy-plane, and easy-cone regimes;
- analytic torque for several $q$, including the $K_{u2}$ term;
- finite-difference derivative of energy versus field;
- cubic $\langle100\rangle$, $\langle110\rangle$, and
  $\langle111\rangle$ energy ordering;
- invariance under a rigid rotation of both magnetization and crystal frame;
- spatial-coefficient cardinality and mask tests;
- CPU/GPU comparison at matched integration/reduction conventions.

(physics-anisotropy-limitations)=
## Limitations and recommended extensions

Surface anisotropy, arbitrary anisotropy tensors, temperature-dependent coefficients, and
crystal frames varying continuously in space require distinct typed contracts. They must not be
encoded by overloading scalar `Ku1` or two cubic axes.

(physics-anisotropy-scientific-bibliography)=
## Scientific bibliography

1. E. C. Stoner and E. P. Wohlfarth, “A mechanism of magnetic hysteresis in heterogeneous alloys,” *Philosophical Transactions of the Royal Society of London. Series A, Mathematical and Physical Sciences* **240**(826), 599–642 (1948). [doi:10.1098/rsta.1948.0007](https://doi.org/10.1098/rsta.1948.0007).
2. C. Kittel, “Physical Theory of Ferromagnetic Domains,” *Reviews of Modern Physics* **21**(4), 541–583 (1949). [doi:10.1103/RevModPhys.21.541](https://doi.org/10.1103/RevModPhys.21.541).
3. J. B. Collings, R. Rama-Eiroa, R. M. Otxoa, R. F. L. Evans, and R. W. Chantrell, “Generalized form of the magnetic anisotropy field in micromagnetic and atomistic spin models,” *Physical Review B* **107**(6), 064413 (2023). [doi:10.1103/PhysRevB.107.064413](https://doi.org/10.1103/PhysRevB.107.064413) | [Open-access PDF (White Rose)](https://eprints.whiterose.ac.uk/id/eprint/197787/1/PhysRevB.107.064413.pdf) | [arXiv:2210.10916](https://arxiv.org/abs/2210.10916).
4. P. Heistracher, C. Abert, F. Bruckner, T. Schrefl, and D. Suess, “Proposal for a micromagnetic standard problem: Domain wall pinning at phase boundaries,” *Journal of Magnetism and Magnetic Materials* **548**, 168875 (2021). [doi:10.1016/j.jmmm.2021.168875](https://doi.org/10.1016/j.jmmm.2021.168875) | [Open-access PDF (CC-BY)](https://www.sciencedirect.com/science/article/pii/S0304885321010817/pdf) | [arXiv:2107.07855](https://arxiv.org/abs/2107.07855).
5. A. Hubert and R. Schäfer, *Magnetic Domains: The Analysis of Magnetic Microstructures*, Springer, Berlin (1998).
6. R. Skomski, *Simple Models of Magnetism*, Oxford University Press (2008).

(physics-anisotropy-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored uniaxial and cubic constants, crystal axes, spatial
fields, and execution request. Resolved execution records the selected solver, device,
precision, discretization, normalized crystal frame, and capability decision. Validation errors
reject malformed vectors, non-finite constants, non-orthogonal cubic frames, or conflicting
legacy-versus-material declarations before runtime. Unsupported combinations fail closed and
are not silently omitted or converted to another interaction.

(physics-anisotropy-implementation-mapping)=
## Implementation mapping

Python owns authoring and legacy-term migration (`MagnetHandle`, `Material`,
`UniaxialAnisotropy`, `CubicAnisotropy`), `ProblemIR` owns canonical material-owned intent,
`plan_fdm` and `plan_fem` own legality and crystal-frame validation, FDM CPU/CUDA own cell-local
polynomial evaluation (`crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs` and
`backends/fdm/gpu/cuda/interactions/demag_fp64.cu`), and FEM CPU/CUDA own nodal/quadrature
realizations (`anisotropy_uniaxial.cpp`, `anisotropy_cubic.cpp`, `anisotropy_kernels.cu`, and
fused `fullmag_cuda_accumulate_heff_fused_xyz`).

(physics-anisotropy-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L512) | [`class UniaxialAnisotropy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L512) | compatibility uniaxial constructor | Python |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L556) | [`class CubicAnisotropy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L556) | compatibility cubic constructor | Python |
| [`packages/fullmag-py/src/fullmag/model/structure.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L16) | [`class Material`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L16) | canonical anisotropy constants, axes, and spatial fields | Python |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L568) | [`class MagnetHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L568) | stage-first `Ku1`/`Ku2`/`anisU` and `Kc1`/`Kc2`/`Kc3`/`anisC1`/`anisC2` authoring | Python |
| [`crates/fullmag-plan/src/fdm.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fdm.rs#L2512) | [`plan_fdm`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fdm.rs#L2512) | FDM anisotropy coefficient/mask resolution | FDM |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L3655) | [`validate_cubic_anisotropy_axes`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L3655) | FEM crystal-frame orthogonality validation | FEM |
| [`crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs#L65) | [`anisotropy_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/anisotropy.rs#L65) | FDM CPU uniaxial and cubic field evaluation | FDM CPU |
| [`crates/fullmag-engine/src/fdm/cpu/fields/energy.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/energy.rs#L502) | [`anisotropy_energy_density_from_vectors`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-engine/src/fdm/cpu/fields/energy.rs#L502) | FDM CPU uniaxial and cubic energy density | FDM CPU |
| [`backends/fdm/gpu/cuda/interactions/demag_fp64.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L574) | [`anisotropy_field_fp64_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/interactions/demag_fp64.cu#L574) | FDM GPU FP64 anisotropy field kernel | FDM GPU |
| [`backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp#L167) | [`compute_uniaxial_anisotropy_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp#L167) | FEM CPU uniaxial field and energy | FEM CPU |
| [`backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp#L127) | [`compute_cubic_anisotropy_field`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/interactions/anisotropy_cubic.cpp#L127) | FEM CPU cubic field and energy | FEM CPU |
| [`backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu#L14) | [`uniaxial_anisotropy_field_energy_blocks_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu#L14) | FEM GPU uniaxial field/energy block kernel | FEM GPU |
| [`backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu#L91) | [`cubic_anisotropy_field_energy_blocks_kernel`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/interactions/anisotropy/anisotropy_kernels.cu#L91) | FEM GPU cubic field/energy block kernel with non-contracted FP64 parity | FEM GPU |
| [`backends/fem/gpu/cuda/fields/vector_field_kernels.hpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/fields/vector_field_kernels.hpp#L91) | [`fullmag_cuda_accumulate_heff_fused_xyz`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/fields/vector_field_kernels.hpp#L91) | single-launch fused `H_eff` accumulation | FEM GPU |
