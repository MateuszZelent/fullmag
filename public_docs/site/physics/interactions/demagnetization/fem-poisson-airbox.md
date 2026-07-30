---
title: FEM Poisson Airbox
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-demagnetization-fem-poisson-airbox)=
# FEM Poisson Airbox

The FEM Poisson-airbox realization introduces a scalar potential on a shared magnetic-plus-air
domain. It is a distinct numerical realization of the common demagnetization equations.

(demag-poisson-problem-statement)=
## Physical problem

The magnetic body is embedded in an airbox so that the exterior field can be approximated on a
bounded domain. The mesh must contain the magnetic and air regions needed by the chosen operator.

(demag-poisson-governing-equations)=
## Governing equations

```{math}
:label: eq-fem-poisson-airbox-weak
\int_{\Omega_a}\nabla u\cdot\nabla v\,\mathrm dV
+\beta\int_{\partial\Omega_a}uv\,\mathrm dS
=\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV.
```

```{math}
:label: eq-fem-poisson-airbox-energy
E_{\mathrm d}=\frac{\mu_0}{2}\left(
\int_{\Omega_a}|\nabla u|^2\,\mathrm dV
+\beta\int_{\partial\Omega_a}u^2\,\mathrm dS\right).
```

(demag-poisson-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $u$ | FEM scalar potential | $\mathrm{A}$ |
| $v$ | test function | $1$ |
| $\Omega_a$ | airbox domain | $\mathrm{m^3}$ |
| $\Omega_m$ | magnetic domain | $\mathrm{m^3}$ |
| $\beta$ | Robin coefficient | $\mathrm{m^{-1}}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |

(demag-poisson-assumptions-and-validity)=
## Assumptions and validity

The airbox is a truncation. Mesh convergence and airbox-distance convergence are independent
requirements. The Robin boundary contribution is part of the operator and energy and must not be
added a second time after field recovery.

(demag-poisson-python-api)=
## Python API

```python
# %% Request the Poisson Robin realization
import fullmag as fm

term = fm.Demag(model="airbox", variant="robin")
print(term.to_ir())
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `optional str` | `None` | $1$ | `airbox` selects Poisson airbox. | Chooses FEM model family. | FEM CPU/GPU where qualified. | `energy[].realization` |
| `Demag.variant` | `optional str` | `None` | $1$ | `robin` or `dirichlet`. | Chooses outer closure. | FEM airbox lanes. | `energy[].realization` |

(demag-poisson-problem-ir)=
## ProblemIR

The canonical IR values are `poisson_robin` and `poisson_dirichlet`. The planner additionally
requires a compatible FEM mesh and solver policy.

(demag-poisson-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Python requested intent and IR realization are separated from resolved execution for FEM CPU/GPU.
Missing air elements, illegal solver policy, or an unsupported device produce validation errors and
unsupported combinations, not permission to switch to FDM.

(demag-poisson-discrete-realization)=
## Discrete realization

MFEM assembles volume stiffness, magnetic right-hand side, boundary operator, and solver workspace.
Field recovery computes $-\nabla u$ and energy uses the same solved potential.

(demag-poisson-implementation-mapping)=
## Implementation mapping

`assemble_demag_poisson_rhs`, `initialize_demag_poisson_boundary_operator`, and
`context_compute_demag_poisson` own the CPU stages. CUDA uses an explicitly separate device-stage
path and requires its own execution proof.

(demag-poisson-validation)=
## Validation

Use manufactured potentials, uniform rectangular bodies, airbox growth, mesh refinement, and
field-energy consistency. Report solver residual and physical error separately.

(demag-poisson-limitations)=
## Limitations

The finite airbox does not prove the exact unbounded solution. Current source and runtime evidence
must be checked before claiming FEM GPU qualification.

(demag-poisson-scientific-bibliography)=
## Scientific bibliography

- Fredkin, D. R. and Koehler, T. R., *IEEE Transactions on Magnetics* 26, 1990.
- FullMag internal reference: `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`.

(demag-poisson-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | Poisson realization validation and IR normalization. |
| `backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp` | `assemble_demag_poisson_rhs` | Magnetic RHS assembly. |
| `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp` | `initialize_demag_poisson_boundary_operator` | Airbox boundary operator. |
| `backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp` | `context_compute_demag_poisson` | Poisson solve orchestration. |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_rhs_csr_kernel` | Device Poisson RHS kernel. |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_recovery_csr_kernel` | Device field-recovery kernel. |
| `backends/fem/gpu/cuda/demag_poisson/demag_kernels.cu` | `demag_energy_blocks_kernel` | Device energy reduction kernel. |
