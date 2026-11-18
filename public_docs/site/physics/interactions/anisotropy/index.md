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
$K_{u1}\sin^2\theta+K_{u2}\sin^4\theta$. The first-order terms differ only by an additive
constant, but the second-order coefficient requires a transformation. Documentation and
docstrings must therefore use the implemented negative-power convention.

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
| $K_{u1},K_{u2}$ | uniaxial coefficients in the Fullmag convention | $\mathrm{J\,m^{-3}}$ |
| $K_{c1},K_{c2},K_{c3}$ | cubic coefficients in the Fullmag convention | $\mathrm{J\,m^{-3}}$ |
| $\hat{\mathbf u}$ | uniaxial axis | $1$ |
| $\hat{\mathbf c}_i$ | orthonormal crystal axes | $1$ |
| $w_{\mathrm u},w_{\mathrm c}$ | local energy density | $\mathrm{J\,m^{-3}}$ |
| $\mathbf H_{\mathrm u},\mathbf H_{\mathrm c}$ | effective field | $\mathrm{A\,m^{-1}}$ |

(physics-anisotropy-assumptions-and-validity)=
## Assumptions and validity

Anisotropy is local and has no independent boundary condition. Active axes must be finite and
non-zero; cubic axes must define a non-degenerate frame and are normalized/orthogonalized only
according to an explicit planner contract. Spatial coefficient fields are mesh-associated data
and must match the realized cell/node cardinality.

(physics-anisotropy-discrete-realization)=
## Backend capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | material fields and compatibility constructors | reference executable | analytic and finite-difference oracles | cell-local field and volume energy sum |
| FDM | GPU | same canonical material IR | implemented | FP32/FP64 qualification separate | device masks and optional coefficient arrays |
| FEM | CPU | same canonical material IR | implemented | mesh/integration convergence required | nodal/element realization and resolved axes |
| FEM | GPU | same canonical material IR | implemented | executed-device parity required | device-resident fields, masks, and reductions |

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

body.Ku1 = 5.0e5
body.anisU = (0.0, 0.0, 1.0)
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=500, tolT=1.0e-6)

# %% Material inspection when authoring higher-order Ku2 or cubic crystal axes
uniaxial_material = fm.Material(
    name="uniaxial_k2_material",
    Ms=8.0e5,
    A=13.0e-12,
    alpha=0.02,
    Ku1=5.0e5,
    Ku2=5.0e4,
    anisU=(0.0, 0.0, 1.0),
)
cubic_material = fm.Material(
    name="cubic_material",
    Ms=8.0e5,
    A=13.0e-12,
    alpha=0.02,
    Kc1=4.8e4,
    Kc2=0.0,
    Kc3=0.0,
    anisC1=(1.0, 0.0, 0.0),
    anisC2=(0.0, 1.0, 0.0),
)
```

On the stage-first handle (`MagnetHandle`), `body.Ku1`, `body.anisU`, and `body.Kc1` are
assigned directly; higher-order constants (`Ku2`, `Kc2`, `Kc3`) and explicit cubic crystal axes
(`anisC1`, `anisC2`) are authored on `fm.Material(...)` or via the compatibility constructors.

`UniaxialAnisotropy` and `CubicAnisotropy` remain supported compatibility constructors; canonical scripts store unambiguous single-material terms on material-owned fields.

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

Compatibility constructors convert constants with `float()` and axes with `as_vector3`, leaving finite and non-zero/orthogonality checks for downstream validation rather than constructor time. On `Material`, `Material.Ku1` and `Material.Ku2` are finite-checked at construction, whereas the cubic material constants are checked during lowering and planning.

Note that the implemented uniaxial convention follows the $-K_{u1}q^2-K_{u2}q^4$ form rather than a $\sin^2/\sin^4$ parameterization; see {doc}`uniaxial` for the exact signs and effective field.

## Required numerical validation

- energy minima/maxima for easy-axis and easy-plane signs;
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
encoded by overloading scalar `Ku` or two cubic axes.

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

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-anisotropy-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(physics-anisotropy-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `UniaxialAnisotropy, CubicAnisotropy` | compatibility constructors |
| `packages/fullmag-py/src/fullmag/model/structure.py` | `Material anisotropy fields` | canonical coefficients and axes |
| `crates/fullmag-plan/src/fdm.rs` | `anisotropy planning` | FDM coefficient/mask resolution |
| `crates/fullmag-plan/src/fem.rs` | `anisotropy planning` | FEM fields and crystal-frame validation |
| `backends/fem/cpu/mfem/interactions/anisotropy_uniaxial.cpp` | `uniaxial field/energy` | implemented negative-power convention |
| `backends/fem/cpu/mfem/interactions` | `cubic anisotropy` | FEM CPU polynomial realization |
| `backends/fdm/gpu/cuda/interactions` | `anisotropy kernels` | FDM GPU realization |
| `backends/fem/gpu/cuda/interactions` | `anisotropy kernels` | FEM GPU realization |
