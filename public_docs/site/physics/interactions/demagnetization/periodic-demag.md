---
title: Periodic Demag
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0800-fem-static-pbc-demag.md
---

(public-docs-physics-interactions-demagnetization-periodic-demag)=
# Periodic Demagnetization

Periodic demagnetization changes the Green problem. FullMag exposes separate FDM truncated-image
and FEM periodic-airbox policies; neither is interchangeable with open-boundary demagnetization.

(demag-periodic-problem-statement)=
## Physical problem

Periodic axes identify corresponding degrees of freedom or image cells. The treatment of the
zero-wave-number mode and the remaining open axes determines whether a scalar potential is unique.

(demag-periodic-governing-equations)=
## Governing equations

```{math}
:label: eq-periodic-demag-reduction
A_p=P^TA_{\mathrm{open}}P,
\qquad
b_p=P^Tb,
\qquad
A_pu_p=b_p.
```

```{math}
:label: eq-periodic-demag-field
\mathbf H_{\mathrm d}=-\nabla(Pu_p),
\qquad
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

(demag-periodic-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $A_p$ | reduced periodic FEM stiffness operator | $\mathrm{m}$ |
| $A_{\mathrm{open}}$ | unreduced FEM stiffness operator | $\mathrm{m}$ |
| $P$ | periodic representative prolongation | $1$ |
| $b_p$ | reduced Poisson right-hand side | $\mathrm{A\,m}$ |
| $u_p$ | reduced scalar potential | $\mathrm{A}$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |

(demag-periodic-assumptions-and-validity)=
## Assumptions and validity

Periodic FEM currently requires at least one open axis and a declared zero-mode policy. FDM
`truncated_images` is a finite approximation to an infinite image sum. Fully periodic 3-D FEM and
FDM `periodic_airbox_k0` are not interchangeable.

(demag-periodic-python-api)=
## Python API

```python
# %% Declare periodic axes and finite FDM image policy
import fullmag as fm

pbc = fm.FdmPbc(
    axes=(True, True, False),
    demag="truncated_images",
    image_counts=(10, 10, 0),
)
print(pbc.to_ir())
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FdmPbc.axes` | `tuple[bool,bool,bool]` | required | $1$ | Exactly three booleans. | Periodic status of x, y, z. | FDM planner. | `pbc.axes` |
| `FdmPbc.demag` | `str` | `open` | $1$ | `open`, `truncated_images`, or `periodic_airbox_k0`. | Demag boundary policy. | Solver-specific. | `pbc.demag` |
| `FdmPbc.image_counts` | `optional tuple[int,int,int]` | `None` | $1$ | Non-negative; only with `truncated_images`. | Finite image count per axis. | FDM. | `pbc.image_counts` |

(demag-periodic-problem-ir)=
## ProblemIR

`FdmPbc.to_ir()` writes periodic/open axis names and the selected demag policy. The planner rejects
`periodic_airbox_k0` for FDM and validates the FEM periodic reduction separately.

(demag-periodic-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is preserved even when unsupported. Resolved execution is recorded separately.
Periodic axes with an incompatible open policy, fully periodic FEM, and invalid image counts are validation errors;
unsupported combinations are never silently changed to open boundaries.

(demag-periodic-discrete-realization)=
## Discrete realization

FDM sums a finite set of translated kernels. FEM identifies mesh classes, reduces the operator and
right-hand side, solves the reduced problem, and lifts the potential to the full mesh.

(demag-periodic-implementation-mapping)=
## Implementation mapping

`FdmPbc` owns Python validation. FDM periodic spectra are computed separately from open spectra;
FEM periodic reduction is implemented by `solve_demag_periodic_poisson_reduced`.

(demag-periodic-validation)=
## Validation

Increase image counts for FDM and compare against a larger reference. For FEM test representative
identification, open-axis solvability, residuals, lifted-field continuity, and field-energy parity.

(demag-periodic-limitations)=
## Limitations

Finite FDM images are not an exact Ewald or infinite periodic sum. The FEM periodic production gate
must be reported independently of historical artifact validation.

(demag-periodic-scientific-bibliography)=
## Scientific bibliography

- FullMag internal references: `docs/physics/0800-fem-static-pbc-demag.md` and
  `docs/physics/0823-native-fem-cpu-pbc-reduced-warm-start.md`.

(demag-periodic-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | Periodic policy validation and IR. |
| `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_periodic_newell_kernel_spectra` | FDM periodic spectra. |
| `backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp` | `solve_demag_periodic_poisson_reduced` | FEM reduced periodic solve. |
