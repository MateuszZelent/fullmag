---
title: Modal Validation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-numerical-methods-eigensolvers-modal-validation)=
# Modal validation and qualification

(numerical-methods-modal-validation-problem-statement)=
## Physical and numerical problem

Modal validation compares computed eigenfrequencies and mode branches with an independent physical
reference. It is not a plot-only step: the equilibrium, field units, $\mathbf k$ sampling, branch
identity, analytical model, tolerance and demagnetization policy define the validation case. Fullmag
supports thin-film Damon–Eshbach/backward-volume dispersion checks and zero-wave-number Kittel field
sweeps as explicit validation intent attached to the study.

(numerical-methods-modal-validation-governing-equations)=
## Governing equations

For each matched mode sample $j$, the relative frequency error is

```{math}
:label: eq-numerical-modal-validation-relative-error
\varepsilon_j=\frac{|f_j^{\mathrm{num}}-f_j^{\mathrm{ref}}|}{|f_j^{\mathrm{ref}}|},
\qquad
\max_j\varepsilon_j\leq\varepsilon_{\max}.
```

For a Kittel field sweep, each selected bias field $\mathbf H_j$ is compared with the declared
macrospin or thin-film analytical frequency $f_{\mathrm{Kittel}}(\mathbf H_j)$:

```{math}
:label: eq-numerical-modal-validation-kittel
f_j^{\mathrm{num}}\approx f_{\mathrm{Kittel}}(\mathbf H_j),
\qquad
\Delta f_j=f_j^{\mathrm{num}}-f_{\mathrm{Kittel}}(\mathbf H_j).
```

The reference does not prescribe a branch-matching algorithm beyond the declared branch ID and
sample indices. A validation result without a reproducible matching rule is not a qualification.

(numerical-methods-modal-validation-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $f_j^{\mathrm{num}}$ | computed frequency at sample $j$ | $\mathrm{Hz}$ |
| $f_j^{\mathrm{ref}}$ | analytical/reference frequency | $\mathrm{Hz}$ |
| $\varepsilon_j$ | relative frequency error | $1$ |
| $\varepsilon_{\max}$ | permitted maximum relative error | $1$ |
| $f_{\mathrm{Kittel}}$ | Kittel reference frequency | $\mathrm{Hz}$ |
| $\mathbf H_j$ | bias field at sample $j$ | $\mathrm{A\,m^{-1}}$ |
| $\Delta f_j$ | signed frequency difference | $\mathrm{Hz}$ |
| $j$ | validation sample index | $1$ |

(numerical-methods-modal-validation-assumptions-and-validity)=
## Assumptions and validity

- Thin-film dispersion validation requires both Damon–Eshbach and backward-volume scenarios, a
  nonzero equilibrium magnetization and a declared film normal.
- Frequency windows and wave-vector bounds are validation-domain limits, not solver convergence
  tolerances. They must be reported separately.
- Kittel validation requires at least three unique nonzero bias-field samples. The
  `thin_film_in_plane` model requires a positive effective magnetization.
- `relative_tolerance` is a comparison threshold. It does not replace mesh, equilibrium, eigenvalue
  residual or branch-tracking evidence.
- Synthetic demagnetization factors, periodic-airbox $k=0$, and no-demag Kittel cases are separate
  physical assumptions and cannot be mixed without an explicit case ID.

(numerical-methods-modal-validation-python-api)=
## Python API

```python
# %% Attach reproducible modal validation intent to a stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("modal_validation")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))
film = study.geometry(fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"), name="film")
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.dispersion_validation(
    fm.ThinFilmDEBVDispersionValidation(
        film_thickness_m=3 * nm,
        equilibrium_magnetization=(1.0, 0.0, 0.0),
        scenarios=[
            {"geometry": "damon_eshbach", "branch_id": "branch_0", "sample_indices": (0, 1, 2)},
            {"geometry": "backward_volume", "branch_id": "branch_0", "sample_indices": (3, 4, 5)},
        ],
    )
)
study.k0_kittel_validation(
    fm.K0KittelFieldSweepValidation(
        samples=[
            {"sample_index": 0, "bias_field": (8.0e3, 0.0, 0.0)},
            {"sample_index": 1, "bias_field": (1.0e4, 0.0, 0.0)},
            {"sample_index": 2, "bias_field": (1.2e4, 0.0, 0.0)},
        ],
        model="macrospin_larmor",
        relative_tolerance=0.05,
        case_id="k0-macrospin",
    )
)
study.stages.add_eigenmodes(count=8, target="lowest", equilibrium_source="provided")
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `ThinFilmDEBVDispersionValidation.film_thickness_m` | `float` | required | $\mathrm{m}$ | positive | film thickness | FEM validation | `runtime_metadata.dispersion_validation.film_thickness_m` |
| `ThinFilmDEBVDispersionValidation.equilibrium_magnetization` | `tuple[float,float,float]` | required | $1$ | nonzero three-vector | equilibrium direction/magnitude input | FEM validation | `runtime_metadata.dispersion_validation.equilibrium_magnetization` |
| `ThinFilmDEBVDispersionValidation.scenarios` | `Sequence[DispersionValidationScenario]` | required | $1$ | must include both geometries | branch/sample cases | FEM validation | `runtime_metadata.dispersion_validation.scenarios` |
| `ThinFilmDEBVDispersionValidation.film_normal` | `tuple[float,float,float]` | `(0,0,1)` | $1$ | nonzero three-vector | film normal | FEM validation | `runtime_metadata.dispersion_validation.film_normal` |
| `ThinFilmDEBVDispersionValidation.frequency_window_hz` | `tuple[float,float]` | `(0,5e9)` | $\mathrm{Hz}$ | nonnegative lower, greater upper, upper at most $5$ GHz | validation frequency domain | FEM validation | `runtime_metadata.dispersion_validation.frequency_window_hz` |
| `ThinFilmDEBVDispersionValidation.max_k_rad_per_m` | `float` | `3e6` | $\mathrm{m^{-1}}$ | positive and at most $3e6$ | wave-vector bound | FEM validation | `runtime_metadata.dispersion_validation.max_k_rad_per_m` |
| `ThinFilmDEBVDispersionValidation.max_relative_error` | `float` | `0.10` | $1$ | positive and at most `0.25` | permitted dispersion error | FEM validation | `runtime_metadata.dispersion_validation.max_relative_error` |
| `ThinFilmDEBVDispersionValidation.analytic_model` | `str` | `kalinikos_slab_n0` | $1$ | currently `kalinikos_slab_n0` | analytical dispersion model | FEM validation | `runtime_metadata.dispersion_validation.analytic_model` |
| `K0KittelFieldSweepValidation.samples` | `Sequence[K0KittelFieldSample]` | required | $1$ | at least three unique samples | bias-field sweep samples | FEM validation | `runtime_metadata.k0_kittel_validation.samples` |
| `K0KittelFieldSweepValidation.model` | `str` | `macrospin_larmor` | $1$ | `macrospin_larmor` or `thin_film_in_plane` | Kittel model | FEM validation | `runtime_metadata.k0_kittel_validation.model` |
| `K0KittelFieldSweepValidation.effective_magnetisation` | `float | None` | `None` | $\mathrm{A\,m^{-1}}$ | positive when required by model | effective magnetization | FEM validation | `runtime_metadata.k0_kittel_validation.material.effective_magnetisation` |
| `K0KittelFieldSweepValidation.relative_tolerance` | `float` | `0.05` | $1$ | positive and at most `0.25` | permitted Kittel error | FEM validation | `runtime_metadata.k0_kittel_validation.relative_tolerance` |
| `K0KittelFieldSweepValidation.case_id` | `str | None` | `None` | $1$ | nonempty when supplied | reproducible case identity | all validation | `runtime_metadata.k0_kittel_validation.case_id` |
| `K0KittelFieldSweepValidation.demag_kind` | `str | None` | `None` | $1$ | `none`, `periodic_airbox_k0`, or `synthetic_demag_factor` | demag assumption | FEM validation | `runtime_metadata.k0_kittel_validation.demag_kind` |

(numerical-methods-modal-validation-problem-ir)=
## ProblemIR and provenance

Validation intent is serialized under runtime metadata and remains distinct from the modal study
request. Provenance records the validation schema, canonicalized units, case ID, source mode branch,
sample mapping, analytical model, tolerance, solver diagnostics and the exact resolved execution.

(numerical-methods-modal-validation-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Script export preserves validation objects and stage ordering. Requested intent and resolved execution
are stored separately. Validation errors include missing geometries, too few samples, duplicate sample
indices, invalid model names, invalid field/frequency windows and tolerance violations. Unsupported combinations
combinations are rejected explicitly; validation metadata cannot make an unsupported solver lane
qualified.

(numerical-methods-modal-validation-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | partial/source-backed | native modal output compared with analytical references |
| FEM | GPU | partial/qualification-dependent | validation can consume a result only after GPU execution identity is proven |
| FDM | CPU | unsupported for this modal validation contract | no native FDM modal lane is claimed |
| FDM | GPU | unsupported for this modal validation contract | no native CUDA modal lane is claimed |

(numerical-methods-modal-validation-implementation-mapping)=
## Implementation mapping

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Dispersion validation schema | `packages/fullmag-py/src/fullmag/model/eigen.py` | `class ThinFilmDEBVDispersionValidation` | validates and serializes dispersion cases | Python |
| Kittel validation schema | `packages/fullmag-py/src/fullmag/model/eigen.py` | `class K0KittelFieldSweepValidation` | validates and serializes field sweeps | Python |
| Modal solver validation | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_modal_eigen_contract` | native modal diagnostics | FEM CPU |

(numerical-methods-modal-validation-validation)=
## Validation

The validation itself must report every sample, branch assignment, reference frequency, computed
frequency, signed difference, relative error and acceptance threshold. In addition, report equilibrium
torque, eigen residuals, mesh/cell resolution, precision, demag policy and runtime identity. A passing
relative-error threshold without these provenance fields is incomplete.

(numerical-methods-modal-validation-limitations)=
## Limitations

Analytical agreement is a qualification gate for the declared domain, not proof of correctness for
all geometries, modes, wave vectors or devices. The current analytical model set is intentionally
bounded by the Python validators and does not represent arbitrary multilayer dispersion.

(numerical-methods-modal-validation-scientific-bibliography)=
## Scientific bibliography

- E. H. Lock, “The Kittel formula for ferromagnetic resonance,” standard macrospin reference.
- I. A. Kalinikos and A. N. Slavin, “Theory of dipole-exchange spin wave spectrum for ferromagnetic films with mixed exchange boundary conditions,” *Journal of Physics C* 19 (1986).
- Canonical modal owner: {doc}`linearized-llg`.

(numerical-methods-modal-validation-source-code-index)=

## Control Room crosswalk

Use `Model Explorer -> Stages -> Add stage -> <stage kind>` for stage-level controls when the terminal page identifies a matching field. The current editor is partial: only fields surfaced by the stage draft are authorable. TODO: frontend support applies to numerical parameters without a matching control. Do not infer frontend support from Python or backend availability. See {doc}/frontend/capability-register for the current register and exact source owner.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Dispersion schema | `packages/fullmag-py/src/fullmag/model/eigen.py` | `class ThinFilmDEBVDispersionValidation` | typed validation payload | Python source |
| Kittel schema | `packages/fullmag-py/src/fullmag/model/eigen.py` | `class K0KittelFieldSweepValidation` | typed validation payload | Python source |
| Native modal diagnostics | `backends/fem/src/frequency_domain/modal_eigen_solver.cpp` | `solve_modal_eigen_contract` | solver status and diagnostics | native source |
