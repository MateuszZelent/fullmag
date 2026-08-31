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

This page is the public physical and authoring contract for the interaction. It separates authored semantics, planner resolution, executable backend lanes, and scientific qualification.

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

## Recommended documentation split

Keep this root as the physical and capability owner. Detailed pages should separately own:
FDM convolution, multilayer convolution, periodic demag, FEM airbox, FEM–BEM/Fredkin–Koehler,
boundary conditions, and validation. Avoid duplicating complete parameter tables and enormous
ProblemIR documents across all children.

(physics-demagnetization-scientific-bibliography)=
## Scientific bibliography

1. W. F. Brown, *Micromagnetics*, Wiley, 1963.
2. A. J. Newell, W. Williams, and D. J. Dunlop, *Journal of Geophysical Research* **98**,
   9551–9555 (1993), DOI: 10.1029/93JB00694.
3. D. R. Fredkin and T. R. Koehler, *IEEE Transactions on Magnetics* **26**, 415–417 (1990).
4. NIST μMAG Standard Problems, current benchmark definitions.

(physics-demagnetization-source-code-index)=

## Control Room crosswalk

This is a navigation page; the selected interaction or foundation is configured by its linked Python API and object/stage editor. The category itself has no standalone control. frontend support is not implemented applies to physical parameters without a matching control. See {doc}/frontend/capability-register; do not infer UI support from backend or Python availability.

## Python/API crosswalk

The linked Python API page is authoritative for exact functions, arguments, units, and failure semantics. If this page is a foundation or category overview, runnable Python is 
ot applicable here and must be taken from the terminal API page.

## Bibliography and source scope

Use the scientific bibliography and source-code index on the linked terminal page. This block adds no new equation or unverified implementation claim.

## Round-trip and failure semantics

Requested intent preserves the authored model, coefficients, orientations, targets, and execution request. Resolved execution records the selected solver, device, precision, discretization, and capability decision. Validation errors reject malformed or contradictory data before runtime. Unsupported combinations fail closed and are not silently omitted or converted to another interaction.

(physics-demagnetization-assumptions-and-validity)=
## Assumptions and validity

The authored model is valid only within the continuum, discretization, boundary, and capability limits stated on this page.

(physics-demagnetization-implementation-mapping)=
## Implementation mapping

Python owns authoring and serialization, ProblemIR owns canonical intent, planners own legality and realization selection, and backend kernels own numerical evaluation.

(physics-demagnetization-limitations)=
## Limitations

Capabilities not listed as executable must fail closed. Source presence alone is not runtime or scientific qualification.

## Source-code index

| Repository path | Stable symbol / area | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `Demag` | public realization vocabulary and IR |
| `packages/fullmag-py/src/fullmag/model/discretization.py` | `FDM, FDMDemag, FEM` | numerical policies |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `FdmPbc` | periodic request semantics |
| `crates/fullmag-plan/src/fdm.rs` | `demag planning` | FDM topology and capability resolution |
| `crates/fullmag-plan/src/fem.rs` | `demag planning` | FEM realization and solver resolution |
| `backends/fdm/cpu` | `demag convolution` | FDM CPU reference |
| `backends/fdm/gpu/cuda/interactions` | `demag kernels/FFT` | FDM GPU realization |
| `backends/fem/cpu/mfem` | `Poisson/BEM demag` | FEM CPU realization |
| `backends/fem/gpu/cuda` | `FEM demag support` | FEM GPU realization |

(physics-demagnetization-round-trip-and-failure-semantics)=
