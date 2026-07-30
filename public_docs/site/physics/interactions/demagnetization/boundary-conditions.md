---
title: Boundary Conditions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-demagnetization-boundary-conditions)=
# Boundary Conditions

Boundary conditions determine which magnetostatic Green problem is solved. They are not a cosmetic
mesh setting.

(demag-boundary-problem-statement)=
## Physical problem

For an isolated body the potential decays at infinity. FEM replaces the unbounded exterior by an
airbox and must declare its outer boundary operator. FDM open convolution represents the exterior
through zero-padding and the demagnetization kernel.

(demag-boundary-governing-equations)=
## Governing equations

```{math}
:label: eq-demag-boundary-open
u(\mathbf x)\longrightarrow0\quad\text{when}\quad|\mathbf x|\longrightarrow\infty.
```

```{math}
:label: eq-demag-boundary-robin
\partial_nu+\beta u=0\quad\text{on }\partial\Omega_a,
\qquad
A=K+\beta M_{\partial\Omega_a}.
```

(demag-boundary-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $u$ | scalar potential | $\mathrm{A}$ |
| $\mathbf n$ | outward boundary normal | $1$ |
| $\beta$ | Robin coefficient | $\mathrm{m^{-1}}$ |
| $\Omega_a$ | airbox domain | $\mathrm{m^3}$ |
| $K$ | geometric FEM volume stiffness matrix | $\mathrm{m}$ |
| $M_{\partial\Omega_a}$ | geometric boundary mass matrix | $\mathrm{m^2}$ |

(demag-boundary-assumptions-and-validity)=
## Assumptions and validity

Robin closure is an approximation to the exterior Dirichlet-to-Neumann map. Its error depends on
airbox geometry, distance, mesh resolution, and coefficient choice. Dirichlet and Robin results
must not be mixed in one convergence table.

(demag-boundary-python-api)=
## Python API

```python
# %% Explicit boundary realization
import fullmag as fm

robin = fm.Demag(model="airbox", variant="robin")
dirichlet = fm.Demag(model="airbox", variant="dirichlet")
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `optional str` | `None` | $1$ | Must be `airbox` for a variant. | Selects airbox family. | FEM airbox. | `energy[].realization` |
| `Demag.variant` | `optional str` | `None` | $1$ | `auto`, `robin`, or `dirichlet`. | Selects outer closure. | FEM CPU/GPU where implemented. | `energy[].realization` |

(demag-boundary-problem-ir)=
## ProblemIR

`airbox/robin` lowers to `poisson_robin`; `airbox/dirichlet` lowers to `poisson_dirichlet`.
The selected value remains visible to planning and provenance.

(demag-boundary-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the Python model and variant. Resolved execution is the actual FEM lane and
boundary operator. Validation errors and unsupported combinations must be reported explicitly; a
planner must not silently replace Robin with Dirichlet or with FDM convolution.

(demag-boundary-discrete-realization)=
## Discrete realization

The FEM operator combines volume stiffness with the boundary mass contribution. The energy must
include the same Robin term exactly once. FDM does not use this airbox matrix.

(demag-boundary-implementation-mapping)=
## Implementation mapping

`initialize_demag_poisson_boundary_operator` owns the FEM boundary operator setup. FDM open-boundary
behavior remains in its tensor/FFT path.

(demag-boundary-validation)=
## Validation

Increase airbox distance and mesh resolution independently. A valid boundary implementation should
show a documented convergence trend for both field and energy; one passing geometry is insufficient.

(demag-boundary-limitations)=
## Limitations

Airbox truncation is not an exact open boundary. The current page does not promote any particular
airbox size or Robin coefficient as universally converged.

(demag-boundary-scientific-bibliography)=
## Scientific bibliography

- Fredkin, D. R. and Koehler, T. R., *IEEE Transactions on Magnetics* 26, 1990.
- FullMag internal reference: `docs/physics/0520-fem-robin-airbox-demag-bootstrap-reference.md`.

(demag-boundary-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | Boundary variant validation and IR normalization. |
| `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` | `initialize_demag_poisson_boundary_operator` | FEM Robin/Dirichlet boundary setup. |
