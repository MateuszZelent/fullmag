---
title: Demagnetization
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-demagnetization-root)=
# Demagnetization

Demagnetization is the non-local magnetostatic self-interaction. The physical problem is common
to all backends, while FDM convolution, FEM airbox, FEM–BEM, periodic kernels, and future FMM
realizations are distinct numerical operators with separate qualification.

```{toctree}
:maxdepth: 1

mathematical-formulation
boundary-conditions
fdm-convolution
multilayer-convolution
fem-poisson-airbox
fem-bem
periodic-demag
validation
```

(physics-demagnetization-problem-statement)=
## Physical problem

Magnetostatic (demagnetizing) interactions couple magnetization divergence in the bulk and on boundaries through long-range dipolar fields that oppose net magnetic flux closure gaps. This overview connects the continuum Poisson/dipolar formulation to Fullmag's `FDM` convolution, `FEM` airbox, and `FEM`–`BEM` solver families across Python authoring, `ProblemIR`, planning, and backend lanes.

(physics-demagnetization-governing-equations)=
## Governing equations

In the magnetostatic approximation,

```{math}
:label: eq-public-demagnetization-demag-maxwell
\nabla\times\mathbf H_{\mathrm d}=\mathbf 0,
\qquad
\nabla\cdot(\mathbf H_{\mathrm d}+\mathbf M)=0 .
```

Introducing a scalar potential $u$,

```{math}
:label: eq-public-demagnetization-demag-potential
\mathbf H_{\mathrm d}=-\nabla u,
\qquad
\Delta u=\nabla\cdot\mathbf M
```

in the distributional sense, including volume and surface magnetic charge. The open-boundary
solution satisfies $u(\mathbf x)\to0$ as $|\mathbf x|\to\infty$. The energy is

```{math}
:label: eq-public-demagnetization-demag-energy
E_{\mathrm d}
=
-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV
=
\frac{\mu_0}{2}\int_{\mathbb R^3}|\mathbf H_{\mathrm d}|^2\,\mathrm dV .
```

The two forms are a valuable implementation cross-check when evaluated consistently.

(physics-demagnetization-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---:|
| $\mathbf M$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $u$ | magnetic scalar potential | $\mathrm A$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm J$ |
| $\Omega_m$ | magnetic domain | not applicable |
| $\mathrm dV$ | volume measure | $\mathrm{m^3}$ |

(physics-demagnetization-discrete-realization)=
## Numerical families

```{figure} /_static/diagrams/demag-solver-families-comparison.svg
:alt: Four-panel comparison of Fullmag demagnetization solver families and continuum magnetic charge sources rho_m = -div M and sigma_m = M . n: (a) FDM open-boundary 2N zero-padded FFT convolution, (b) FEM Poisson with shared finite airbox Omega_m subset Omega_a and Dirichlet or Robin outer closure on Gamma_a, (c) FEM-BEM Fredkin-Koehler two-solve boundary-integral method on closed body-only mesh Omega_m without an airbox, and (d) periodic replicated images in FDM truncated_images versus FEM reduced periodic_airbox_k0.
:width: 100%
:name: fig-demag-solver-families-comparison
:figclass: fm-physics-figure

Continuum magnetostatic charge sources ($\rho_m = -\nabla\cdot\mathbf{M}$, $\sigma_m = \mathbf{M}\cdot\mathbf{n}$) and Fullmag's four discrete demagnetization operator families across **FDM CPU**, **FDM GPU**, **FEM CPU**, and **FEM GPU** (Brown 1963; Newell *et al.* 1993; Fredkin & Koehler 1990; Lepadatu 2019).
```

- **FDM open convolution** uses a cell-integrated demagnetization tensor and FFT acceleration.
- **FDM periodic/truncated images** changes the Green function and requires an explicit zero-mode
  convention.
- **FEM airbox** truncates the exterior domain and imposes a documented outer boundary condition.
- **FEM–BEM / Fredkin–Koehler** represents the open exterior through boundary operators.
- **FMM** is accepted vocabulary only where the planner/runtime actually materializes it.

No model name may be promoted from “accepted by Python” to “executable” without planner and
runtime evidence.

## Backend capability matrix

| Solver | Device | Authoring / IR | Executable realization | Scientific qualification | Exact boundary |
|---|---|---|---|---|---|
| FDM | CPU | `Demag()` plus FDM policy | reference executable | Newell/ellipsoid and convergence tests required | single-grid and selected multilayer convolution |
| FDM | GPU | same canonical IR | implemented | device identity and precision-specific parity required | FFT and tensor realization; no host fallback in strict mode |
| FEM | CPU | `airbox`, selected BEM/FK vocabulary | implemented for qualified subsets | airbox-size/mesh and boundary-operator convergence required | model-specific planner gates |
| FEM | GPU | same requested model vocabulary | partial | device-resident solve not uniformly qualified | model, solver, preconditioner, and Hypre device support are decisive |

(physics-demagnetization-python-api)=
## Python API and stage-first example

```python
# %% Study, execution lane, and magnetic body
import fullmag as fm

nm = 1.0e-9
study = fm.study("demag_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 2 * nm))
body = study.geometry(fm.Box(40 * nm, 20 * nm, 4 * nm), name="film")
body.Ms = 8.0e5
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.stages.add_run(stage_id="sample", until=1.0e-12)
```

Exchange and demagnetization are active by default. Call `study.demag(realization=...)` only to
select a non-default realization. Call `study.disable_demag()` only when the authored physics
intentionally excludes demagnetization.
A FEM request should state its realization and solver policy explicitly, for example
`study.demag(realization="poisson_robin")`, together with the airbox and mesh controls.

## Public constructor boundary

`Demag(model=..., variant=..., realization=...)` is backend-neutral. `model` and legacy
`realization` are mutually exclusive. Airbox variants are meaningful only for the airbox family.
FDM grid, multilayer topology, periodicity, boundary correction, and FEM linear-solver settings
belong to discretization policy, not to the continuum energy.

(physics-demagnetization-problem-ir)=
## ProblemIR

The default term lowers as

```json
{"kind": "demag", "realization": "auto"}
```

The planner must retain both requested and resolved realization. It must also record grid/mesh,
periodicity, airbox, solver, tolerance, preconditioner, precision, and actual execution device.

(physics-demagnetization-validation)=
## Validation and failure semantics

Constructor acceptance of `bem`, `fredkin_koehler`, or `fmm` is not proof that a selected
solver/device lane executes it. Invalid model/variant combinations, unsupported periodic
policies, missing shared-domain meshes, incompatible GPU solver policies, and unavailable
observables must fail closed. Algebraic residual tolerance does not bound airbox truncation,
mesh, or boundary-quadrature error.

## Required numerical validation

- analytic uniformly magnetized ellipsoids;
- Newell tensor values and symmetry identities for FDM;
- zero net field for appropriate periodic uniform modes under the documented $k=0$ policy;
- convergence with cell size, FEM mesh, airbox padding, and boundary discretization;
- equivalence of the two energy expressions where numerically available;
- μMAG standard problems with declared mesh and stopping criteria;
- CPU/GPU comparisons at identical geometry, material, precision, and reduction convention;
- multilayer translation, self/cross-layer symmetry, and common-grid convergence.

(physics-demagnetization-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-demagnetization-assumptions-and-validity)=
## Assumptions and validity

Magnetostatic evaluation assumes piecewise-constant (`FDM`) or continuous piecewise-linear (`FEM`) reduced magnetization $\mathbf{m}$ with finite non-negative saturation $M_s$ over the active magnetic domain. Accuracy and planner legality depend on the selected solver family (uniform structured grids for single-grid and multilayer `FDM` convolution, conformal exterior airbox extent for `FEM` Poisson, or surface boundary-element coupling for `FEM`–`BEM`), the declared periodic boundary policy (`open` or `FdmPbc`), and the active numeric precision.

(physics-demagnetization-implementation-mapping)=
## Implementation mapping

Python classes (`Demag`, `FDM`, `FDMDemag`, `FEM`, and `FdmPbc`) own authoring validation and `ProblemIR` serialization, while `crates/fullmag-plan` (`fdm.rs` and `fem.rs`) resolves topology, periodic bounds, and solver realization. Native `FDM` (`backends/fdm/cpu`, `backends/fdm/gpu/cuda`) and `FEM` (`backends/fem/cpu/mfem`, `backends/fem/gpu/cuda`) kernels perform numerical evaluation without silent GPU-to-CPU fallback.

### Control Room support

When `PhysicsInteractionPanel` exposes demagnetization under `Model Explorer -> Objects -> <object> -> Physics`, support is partial: parameters without a UI control must be configured via the Python API or `ProblemIR` rather than inferred from backend availability. See {doc}`/frontend/capability-register` for current browser exposure.

(physics-demagnetization-limitations)=
## Limitations

Pure-`FEM` Poisson airbox accuracy degrades if the airbox boundary is too close to the magnetic sample, while `FDM` FFT convolution requires structured grids and currently rejects periodic boundary conditions in multilayer convolution mode. Any capability not marked executable fails closed; source presence alone does not constitute runtime or scientific qualification.

(physics-demagnetization-scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York, 1963 ([WorldCat record](https://search.worldcat.org/title/536451)).
2. A. J. Newell, W. Williams, and D. J. Dunlop, “A generalization of the demagnetizing tensor for nonuniform magnetization,” *Journal of Geophysical Research: Solid Earth* **98**(B6), 9551–9555 (1993), [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
3. D. R. Fredkin and T. R. Koehler, “Hybrid method for computing demagnetizing fields,” *IEEE Transactions on Magnetics* **26**(2), 415–417 (1990), [doi:10.1109/20.106342](https://doi.org/10.1109/20.106342).
4. M. J. Donahue and D. G. Porter, *OOMMF User's Guide, Version 1.0*, National Institute of Standards and Technology, NISTIR 6376 (1999), [doi:10.6028/NIST.IR.6376](https://doi.org/10.6028/NIST.IR.6376).

(physics-demagnetization-source-code-index)=
## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | public realization vocabulary and IR |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDM, FDMDemag, FEM` | numerical policies |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `FdmPbc` | periodic request semantics |
| `crates/fullmag-plan/src/fdm.rs` | `demag planning` | FDM topology and capability resolution |
| `crates/fullmag-plan/src/fem.rs` | `demag planning` | FEM realization and solver resolution |
| `backends/fdm/cpu` | `demag convolution` | FDM CPU reference |
| `backends/fdm/gpu/cuda/interactions` | `demag kernels/FFT` | FDM GPU realization |
| `backends/fem/cpu/mfem` | `Poisson/BEM demag` | FEM CPU realization |
| `backends/fem/gpu/cuda` | `FEM demag support` | FEM GPU realization |
