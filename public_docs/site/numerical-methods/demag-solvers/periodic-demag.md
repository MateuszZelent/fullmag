---
title: Periodic Demag
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0800-fem-static-pbc-demag.md
---

(public-docs-numerical-methods-demag-solvers-periodic-demag)=
# Periodic demagnetization solvers

(numerical-methods-periodic-demag-problem-statement)=
## Physical and numerical problem

The canonical interaction is owned by {doc}`../../physics/interactions/demagnetization/periodic-demag`.
Periodic demagnetization is a different Green-function problem from open-boundary demagnetization:
an axis marked periodic identifies translated cells or representative mesh degrees of freedom, and
the zero-wave-number or null-potential policy becomes part of the numerical problem. Fullmag has
two documented realization families: finite translated-image summation for FDM and a reduced
periodic Poisson system for FEM. Neither is silently substituted for the other or for the open
kernel.

(numerical-methods-periodic-demag-governing-equations)=
## Governing equations

For FEM, let $P$ lift one value per periodic representative to all equivalent mesh degrees of
freedom. The reduced stiffness system is

```{math}
:label: eq-numerical-periodic-demag-reduction
A_p=P^{T}A_{\mathrm{open}}P,
\qquad
b_p=P^{T}b,
\qquad
A_pu_p=b_p.
```

The physical potential is lifted before taking its gradient, and the field-based energy is reduced
over the magnetic volume:

```{math}
:label: eq-numerical-periodic-demag-field-energy
\mathbf H_{\mathrm d}=-\nabla(Pu_p),
\qquad
E_{\mathrm d}=-\frac{\mu_0}{2}\int_{\Omega_m}
\mathbf M\cdot\mathbf H_{\mathrm d}\,\mathrm dV.
```

For FDM, the open Newell tensor is replaced by a periodic finite-image tensor. With translation
vectors $\mathbf t_{\boldsymbol\ell}$ and image set $\mathcal I$, the discrete convolution is

```{math}
:label: eq-numerical-periodic-demag-fdm-sum
\mathbf H_{\mathrm d}(\mathbf r_i)=
\sum_{\boldsymbol\ell\in\mathcal I}
\mathbf N(\mathbf r_i-\mathbf r_j-\mathbf t_{\boldsymbol\ell})\mathbf M(\mathbf r_j),
\qquad
\mathcal I=\{-n_x,\ldots,n_x\}\times\{-n_y,\ldots,n_y\}\times\{-n_z,\ldots,n_z\}.
```

The image counts therefore change the operator itself. They are not a gauge parameter and are not
interchangeable with the FEM null-space treatment.

(numerical-methods-periodic-demag-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $A_p$ | reduced periodic FEM stiffness operator | $\mathrm{m}$ |
| $A_{\mathrm{open}}$ | unreduced FEM stiffness operator | $\mathrm{m}$ |
| $P$ | periodic representative prolongation | $1$ |
| $b_p$ | reduced Poisson right-hand side | $\mathrm{A\,m}$ |
| $b$ | unreduced Poisson right-hand side | $\mathrm{A\,m}$ |
| $u_p$ | reduced scalar potential | $\mathrm{A}$ |
| $\mathbf H_{\mathrm d}$ | demagnetizing field | $\mathrm{A\,m^{-1}}$ |
| $E_{\mathrm d}$ | demagnetization energy | $\mathrm{J}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\Omega_m$ | magnetic volume | $\mathrm{m^3}$ |
| $\mathbf r_i$ | FDM cell-center position | $\mathrm{m}$ |
| $\mathbf t_{\boldsymbol\ell}$ | periodic translation vector | $\mathrm{m}$ |
| $\mathcal I$ | finite image-index set | $1$ |
| $n_x,n_y,n_z$ | image counts along each axis | $1$ |
| $\mathbf N$ | demagnetizing tensor kernel | $1$ |
| $\mathbf M$ | magnetization field | $\mathrm{A\,m^{-1}}$ |

(numerical-methods-periodic-demag-assumptions-and-validity)=
## Assumptions and validity

- `FdmPbc.axes` contains exactly three Boolean axis flags. `demag="truncated_images"` is a finite
  approximation to an infinite image sum; increasing image counts is required for a convergence
  study.
- FEM periodic reduction requires a valid periodic mesh certificate and a separately recorded
  null-space/zero-mode policy. An apparently finite energy does not prove that the null mode was
  handled correctly.
- A periodic request must preserve axis order, image semantics, precision and field normalization
  between CPU and GPU before parity is evaluated.
- `periodic_airbox_k0` is FEM-only. It is a planner error for FDM and must not silently fall back
  to `open` or `truncated_images`.
- The periodic page describes current source-visible paths. A source-visible GPU function is not by
  itself a production qualification claim.

(numerical-methods-periodic-demag-python-api)=
## Python API

The public authoring surface is stage-first. Periodicity is attached to the study before stages are
created; it is not expressed through a legacy `fm.Problem(...)` aggregate.

```python
# %% Periodic FDM demagnetization with explicit image truncation
import fullmag as fm

nm = 1.0e-9
study = fm.study("periodic_fdm_demag")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
study.pbc(x=True, y=True, z=False, demag="truncated_images", images=(4, 4, 0))
film = study.geometry(
    fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.demag()
study.solver(
    integrator="rk45",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-12,
    max_err=1.0e-7,
)
study.stages.add_relax(
    stage_id="relax",
    algorithm="llg_overdamped",
    solver="rk45",
    dt_initial=1.0e-15,
    dt_min=1.0e-17,
    dt_max=1.0e-12,
    max_err=1.0e-7,
    max_steps=100,
    tolT=1.0e-6,
)
```

`study.pbc(...)` is the stage-first facade. The equivalent serialized object is `fm.FdmPbc`; the
constructor is useful when inspecting or testing the Python contract, while the documented script
should keep study construction and stage ordering visible.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `FdmPbc.axes` | `tuple[bool,bool,bool]` | required | $1$ | exactly three Boolean values | periodic status of x, y, z | FDM planner; FEM mesh planner consumes the same intent | `pbc.axes` |
| `FdmPbc.demag` | `str` | `open` | $1$ | `open`, `truncated_images`, or `periodic_airbox_k0` | demagnetization boundary policy | FDM supports `open`/`truncated_images`; FEM supports the periodic airbox policy subject to qualification | `pbc.demag` |
| `FdmPbc.image_counts` | `tuple[int,int,int] | None` | `None` | $1$ | exactly three non-negative integers; only with `truncated_images` | finite image counts $n_x,n_y,n_z$ | FDM CPU/GPU image policies as qualified | `pbc.image_counts` |
| `study.pbc(..., x/y/z=...)` | `bool` flags | all `False` | $1$ | at least one axis for non-open policy | stage-first authoring facade for `FdmPbc.axes` | Python authoring; planner resolves backend legality | `pbc.axes` |

(numerical-methods-periodic-demag-problem-ir)=
## ProblemIR and provenance

The periodic policy is lowered independently from the interaction term:

```json
{
  "energy_terms": [{"kind": "demag"}],
  "backend_policy": {
    "engine": "fdm",
    "pbc": {
      "axes": ["periodic", "periodic", "open"],
      "demag": "truncated_images",
      "image_counts": [4, 4, 0]
    }
  }
}
```

The IR records requested periodic axes and the selected policy. Resolved execution must additionally
record the chosen FDM/FEM lane, precision, actual image counts or representative-map certificate,
zero-mode treatment, solver residuals, field recovery and energy reduction. Requested intent and
resolved execution are not interchangeable provenance fields.

(numerical-methods-periodic-demag-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export preserves the stage-first study, periodic axes and demagnetization policy. Validation
errors include a wrong axis tuple length, invalid image counts, image counts without
`truncated_images`, `periodic_airbox_k0` requested for FDM, missing periodic mesh pairing and an
unresolved FEM null mode. Unsupported combinations are rejected explicitly; no fallback to the open
kernel is permitted. Requested intent remains visible even when resolved execution reports an
unsupported lane, and the planner must report validation errors before runtime submission.

(numerical-methods-periodic-demag-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FDM | CPU | partial/source-backed | periodic Newell spectra with finite translated-image truncation |
| FDM | GPU | partial/qualification-dependent | separate CUDA realization only when the selected policy is qualified |
| FEM | CPU | partial/source-backed | periodic representative reduction of the Poisson system |
| FEM | GPU | partial/qualification-dependent | separate device realization; CPU source presence does not establish parity |

For FDM, changing `image_counts` changes the convolution kernel and therefore the computed field.
For FEM, changing the periodic node equivalence classes changes the matrix topology and right-hand
side. CPU/GPU results are comparable only after the same policy, mesh/cell topology, precision,
zero-mode handling and tolerances are recorded.

(numerical-methods-periodic-demag-implementation-mapping)=
## Implementation mapping

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Python policy | `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | validates axes, policy and image counts; lowers periodic intent | Python/IR |
| FDM periodic kernel | `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_periodic_newell_kernel_spectra` | computes periodic kernel spectra for the FDM convolution | FDM CPU |
| FEM periodic reduction | `backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp` | `solve_demag_periodic_poisson_reduced` | reduces and solves the periodic Poisson system | FEM CPU |

(numerical-methods-periodic-demag-validation)=
## Validation

FDM validation must sweep image counts, compare field and energy observables against a larger-image
reference, and test CPU/GPU parity at identical precision and axis order. FEM validation must check
periodic mesh certificates, representative-map completeness, open-axis solvability, reduced-system
residuals, zero-mode handling, field continuity across seams and the field-energy identity. A finite
energy alone is insufficient evidence for either realization.

(numerical-methods-periodic-demag-limitations)=
## Limitations

Finite image summation is not an exact Ewald or infinite periodic Green function. Periodic FEM
qualification is independent of the FDM image study and independent of open-airbox convergence.
This reference does not claim a universal fully periodic 3-D FEM solution or GPU qualification for
every periodic policy.

(numerical-methods-periodic-demag-scientific-bibliography)=
## Scientific bibliography

- A. J. Newell, W. Williams, and D. J. Dunlop, “A method for computing the magnetostatic demagnetizing tensor for rectangular prisms,” *Geophysical Journal International* 124 (1993), 938–946, DOI: [10.1111/j.1365-246X.1993.tb04780.x](https://doi.org/10.1111/j.1365-246X.1993.tb04780.x).
- Fullmag internal periodic FEM design: `docs/physics/0800-fem-static-pbc-demag.md`.
- Canonical physics owner: {doc}`../../physics/interactions/demagnetization/periodic-demag`.

(numerical-methods-periodic-demag-source-code-index)=

## Control Room crosswalk

Use `Model Explorer -> Stages -> Add stage -> <stage kind>` for stage-level controls when the terminal page identifies a matching field. The current editor is partial: only fields surfaced by the stage draft are authorable. Numerical parameters without a matching control are not implemented in the frontend. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Python periodic contract | `packages/fullmag-py/src/fullmag/model/problem.py` | `class FdmPbc` | validation and IR lowering | Python contract tests |
| FDM periodic spectra | `crates/fullmag-engine/src/fdm/cpu/fft.rs` | `compute_periodic_newell_kernel_spectra` | finite-image kernel spectrum | FDM source contract |
| FEM reduced solve | `backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp` | `solve_demag_periodic_poisson_reduced` | periodic Poisson reduction | FEM source contract |
