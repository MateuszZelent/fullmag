---
title: FEM Bem
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-physics-interactions-demagnetization-fem-bem)=
# FEM/BEM

The Fredkin--Koehler FEM/BEM realization keeps the magnetic volume in FEM and represents the open
exterior through a boundary integral. It avoids identifying a finite airbox with infinity.

(demag-bem-problem-statement)=
## Physical problem

For a closed tetrahedral magnetic body, decompose the potential into an interior Poisson solution
and a harmonic boundary correction. The boundary operator is dense in the current reference path.

(demag-bem-governing-equations)=
## Governing equations

```{math}
:label: eq-fem-bem-decomposition
u=u_1+u_2,
\qquad
\int_{\Omega_m}\nabla u_1\cdot\nabla v\,\mathrm dV
=\int_{\Omega_m}\mathbf M\cdot\nabla v\,\mathrm dV.
```

```{math}
:label: eq-fem-bem-energy
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf M\cdot(-\nabla(u_1+u_2))\,\mathrm dV.
```

(demag-bem-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $u$ | total scalar potential | $\mathrm{A}$ |
| $u_1$ | interior Poisson potential | $\mathrm{A}$ |
| $u_2$ | harmonic BEM correction | $\mathrm{A}$ |
| $\Omega_m$ | magnetic volume | $\mathrm{m^3}$ |
| $v$ | FEM test function | $1$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |

(demag-bem-assumptions-and-validity)=
## Assumptions and validity

The reference path assumes a closed surface and uses a dense boundary operator. Acceleration by
FMM or hierarchical matrices is not implied by the `fmm` vocabulary and is not claimed here.

(demag-bem-python-api)=
## Python API

```python
# %% Request the body-only Fredkin--Koehler realization
import fullmag as fm

term = fm.Demag(model="fredkin_koehler")
print(term.to_ir())
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Demag.model` | `optional str` | `None` | $1$ | `fredkin_koehler`, `bem`, or another canonical name. | Chooses BEM family. | Planner-dependent. | `energy[].realization` |
| `Demag.variant` | `optional str` | `None` | $1$ | Must be omitted for BEM models. | Airbox-only selector. | Not applicable to BEM. | `energy[].realization` |

(demag-bem-problem-ir)=
## ProblemIR

`fredkin_koehler` lowers to the same named realization. The planner must verify body-only mesh
legality and the available FEM/BEM implementation.

(demag-bem-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

The export preserves requested intent even when the planner rejects it. Resolved execution is
reported separately. Validation errors and unsupported combinations are explicit; `bem` and `fmm`
must not be silently treated as an airbox.

(demag-bem-discrete-realization)=
## Discrete realization

The volume RHS is assembled in FEM, the boundary trace is assembled on the surface, the dense
operator is solved, and the two potentials are combined before field and energy evaluation.

(demag-bem-implementation-mapping)=
## Implementation mapping

`prepare_demag_fem_bem_neumann_rhs`, `context_compute_demag_fem_bem`, and
`combine_demag_fem_bem_total_potential` represent the principal stages.

(demag-bem-validation)=
## Validation

Validate a uniformly magnetized rectangular body, surface orientation, solid-angle/self terms,
field recovery, and energy against an independent open-boundary reference.

(demag-bem-limitations)=
## Limitations

The current documented realization is a dense CPU reference path. FMM acceleration, periodic
FEM/BEM, and broad GPU qualification remain outside this claim.

(demag-bem-scientific-bibliography)=
## Scientific bibliography

- Fredkin, D. R. and Koehler, T. R., *IEEE Transactions on Magnetics* 26, 1990.
- FullMag internal reference: `docs/physics/0870-fem-bem-demag-open-boundary.md`.

(demag-bem-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class Demag` | BEM model validation and IR normalization. |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_rhs.cpp` | `prepare_demag_fem_bem_neumann_rhs` | BEM Neumann RHS. |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_solve.cpp` | `context_compute_demag_fem_bem` | FEM/BEM solve orchestration. |
| `backends/fem/cpu/mfem/interactions/demag_fem_bem_potential.cpp` | `combine_demag_fem_bem_total_potential` | Potential combination. |
