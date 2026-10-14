---
title: Modal Validation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0600-fem-eigenmodes-linearized-llg.md and docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md
---

(public-docs-numerical-methods-eigensolvers-modal-validation)=
# Modal validation and qualification

(numerical-methods-modal-validation-problem-statement)=
## Scope and purpose

Modal validation compares computed eigenfrequencies $f_j^{\mathrm{num}}$, spatial mode profiles
$\delta\mathbf m_j(\mathbf r)$, and tracked dispersion branches $\omega_b(\mathbf k)$ against
independent analytical and algebraic references. In Fullmag, modal validation is a typed contract
attached to the study (`ThinFilmDEBVDispersionValidation` and `K0KittelFieldSweepValidation`), not
an informal post-processing script: the static equilibrium $\mathbf m_0$, bias-field sequence,
wave-vector path, branch identity, demagnetization realization (`none`, `periodic_airbox_k0`, or
`synthetic_demag_factor`), analytical model (`macrospin_larmor`, `thin_film_in_plane`, or
`kalinikos_slab_n0`), and error threshold $\varepsilon_{\max}$ are all recorded in `ProblemIR` and
verified against the executed runtime provenance.

A frequency comparison alone does not qualify a modal solver. Every qualified result must
simultaneously satisfy the R4 equilibrium torque gate, tangent-plane orthogonality, coupled
magnetostatic descriptor residual bounds $(r_q, r_\phi)$, true unpreconditioned KSP convergence in
shift-and-invert solves, and mass-weighted branch-overlap continuity.

(numerical-methods-modal-validation-governing-equations)=
## Scientific and numerical model

### 1. Relative and signed frequency error gates

For each matched validation sample $j \in \{0,\dots,N_{\mathrm{val}}-1\}$, the dimensionless
relative frequency error $\varepsilon_j$ and signed frequency shift $\Delta f_j$ against the
analytical reference $f_j^{\mathrm{ref}}$ are

```{math}
:label: eq-numerical-modal-validation-relative-error
\varepsilon_j
= \frac{\left|f_j^{\mathrm{num}} - f_j^{\mathrm{ref}}\right|}{\left|f_j^{\mathrm{ref}}\right|},
\qquad
\max_j \varepsilon_j \le \varepsilon_{\max}.
```

### 2. $\mathbf k = 0$ Kittel ferromagnetic resonance field sweeps

In a uniform ferromagnetic resonance ($\mathbf k = 0$) bias-field sweep (`K0KittelFieldSweepValidation`),
each external static field sample $\mathbf H_j$ with magnitude $H_0 = \|\mathbf H_j\|_2$ along the
equilibrium direction $\mathbf m_0$ is compared against the Kittel reference frequency
$f_{\mathrm{Kittel}}(\mathbf H_j)$:

```{math}
:label: eq-numerical-modal-validation-kittel
f_j^{\mathrm{num}} \approx f_{\mathrm{Kittel}}(\mathbf H_j),
\qquad
\Delta f_j = f_j^{\mathrm{num}} - f_{\mathrm{Kittel}}(\mathbf H_j).
```

Depending on the declared `model` and `demag_kind`, the analytical reference frequency is evaluated
from one of the canonical macrospin or thin-film Kittel relations ($\gamma_0 = \mu_0|\gamma|$):

```{math}
:label: eq-numerical-modal-validation-kittel-models
f_{\mathrm{Larmor}}(H_0) = \frac{\gamma_0}{2\pi}\,H_0,
\qquad
f_{\mathrm{film}}(H_0) = \frac{\gamma_0}{2\pi}\sqrt{H_0\left(H_0 + M_{\mathrm{eff}}\right)},
\qquad
f_{\mathrm{demag}}(H_0) = \frac{\gamma_0}{2\pi}\sqrt{\left(H_0 + (N_x - N_z)M_s\right)\left(H_0 + (N_y - N_z)M_s\right)},
```

where $M_{\mathrm{eff}}$ is the effective thin-film out-of-plane demagnetizing/anisotropy
magnetization (`effective_magnetisation`) and $(N_x, N_y, N_z)$ are the diagonal demagnetizing
factors (`demag_factors`, satisfying $N_x + N_y + N_z = 1$ in SI).

### 3. Kalinikos–Slavin thin-film dipole-exchange dispersion (`kalinikos_slab_n0`)

For an in-plane magnetized ferromagnetic film of thickness $d$ (`film_thickness_m`), saturation
magnetization $M_s$, exchange stiffness $A_{\mathrm{ex}}$ with squared exchange length
$\ell_{\mathrm{ex}}^2 = 2A_{\mathrm{ex}}/(\mu_0 M_s^2)$, internal static bias field $H_0$, and
in-plane wave vector $\mathbf k$ of magnitude $k = \|\mathbf k\|_2$ at angle $\varphi_{\mathbf k}$
to $\mathbf m_0$, the lowest thickness-uniform ($n=0$) Kalinikos–Slavin dipole-exchange dispersion
relation is

```{math}
:label: eq-numerical-modal-validation-kalinikos-slavin
f_{\mathrm{KS}}(\mathbf k)
= \frac{\gamma_0}{2\pi}\sqrt{
\left(H_0 + M_s\ell_{\mathrm{ex}}^2 k^2 + M_s\left(1 - P_{00}(kd)\right)\sin^2\varphi_{\mathbf k}\right)
\left(H_0 + M_s\ell_{\mathrm{ex}}^2 k^2 + M_s P_{00}(kd)\right)
},
\qquad
P_{00}(kd) = 1 + \frac{\exp(-kd) - 1}{kd}.
```

The two canonical validation geometries required by `ThinFilmDEBVDispersionValidation` correspond to
the principal in-plane propagation limits:

- **Damon–Eshbach (`geometry="damon_eshbach"`)**: $\mathbf k \perp \mathbf m_0$ ($\sin^2\varphi_{\mathbf k} = 1$),
  exhibiting positive group velocity at small $kd$ due to the magnetostatic term $1 - P_{00}(kd)$;
- **Backward volume (`geometry="backward_volume"`)**: $\mathbf k \parallel \mathbf m_0$
  ($\sin^2\varphi_{\mathbf k} = 0$), exhibiting negative group velocity in the dipolar regime before
  exchange $\ell_{\mathrm{ex}}^2 k^2$ dominates at larger $k$.

### 4. Coupled descriptor residual and mass-weighted mode overlap

Every validated mode $(\lambda_n, \mathbf q_n, \boldsymbol\phi_n)$ must simultaneously satisfy the
coupled magnetic-Poisson residual bound (`evaluate_poisson_airbox_modal_residuals`) and, across mesh
refinement or parameter steps, maintain mass-weighted spatial overlap (`ConsistentP1TrackingMetric`):

```{math}
:label: eq-numerical-modal-validation-overlap
\varepsilon_{\mathrm{eig},n}
= \frac{\sqrt{\|r_{q,n}\|_2^2 + \|r_{\phi,n}\|_2^2}}
{\|A_{qq}\mathbf q_n + A_{q\phi}\boldsymbol\phi_n\|_2 + |\lambda_n|\,\|B_{qq}\mathbf q_n\|_2},
\qquad
\mathcal O_{ab}
= \frac{\left|v_a^\ast M v_b\right|}
{\sqrt{v_a^\ast M v_a}\,\sqrt{v_b^\ast M v_b}}.
```

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
| $H_0, M_{\mathrm{eff}}, M_s$ | internal static bias field, effective thin-film magnetization, and saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\gamma_0$ | rescaled gyromagnetic prefactor $\mu_0|\gamma|$ | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $f_{\mathrm{Larmor}}, f_{\mathrm{film}}, f_{\mathrm{demag}}$ | Larmor, thin-film in-plane, and general ellipsoidal Kittel frequencies | $\mathrm{Hz}$ |
| $N_x, N_y, N_z$ | diagonal demagnetizing factors ($N_x+N_y+N_z=1$) | $1$ |
| $f_{\mathrm{KS}}, P_{00}(kd)$ | Kalinikos–Slavin $n=0$ frequency and dipolar form factor | $\mathrm{Hz}$, $1$ |
| $d, \ell_{\mathrm{ex}}, k, \varphi_{\mathbf k}$ | film thickness, exchange length, wave-vector magnitude, and in-plane propagation angle | $\mathrm{m}$, $\mathrm{m}$, $\mathrm{rad\,m^{-1}}$, $\mathrm{rad}$ |
| $\varepsilon_{\mathrm{eig},n}, r_{q,n}, r_{\phi,n}$ | relative coupled eigenpair residual and magnetic/Poisson block residuals | $1$, problem-dependent |
| $A_{qq}, A_{q\phi}, B_{qq}, \mathbf q_n, \boldsymbol\phi_n, \lambda_n$ | coupled magnetostatic blocks, tangent mode vector, scalar potential vector, and eigenvalue | problem-dependent, $1$, $\mathrm{A}$, $\mathrm{s^{-1}}$ |
| $M, \mathcal O_{ab}, v_a, v_b$ | consistent $P_1$ mass matrix, mode overlap, and complex spatial mode vectors | $\mathrm{m^3}$, $1$, $1$ |

(numerical-methods-modal-validation-assumptions-and-validity)=
## Assumptions and validity

| Choice | Mathematical meaning | What it does not mean |
|---|---|---|
| `ThinFilmDEBVDispersionValidation` | Requires both `"damon_eshbach"` and `"backward_volume"` scenarios, positive `film_thickness_m`, nonzero `equilibrium_magnetization`, and wave numbers $k \le 3\times 10^6\,\mathrm{rad\,m^{-1}}$. | It does not validate thick multilayer waveguides or higher perpendicular standing spin-wave modes ($n \ge 1$). |
| `K0KittelFieldSweepValidation` | Requires at least three unique nonzero bias-field samples and compares against `macrospin_larmor` or `thin_film_in_plane`. | It does not qualify inhomogeneous edge/vortex modes unless the uniform Kittel branch is explicitly tracked. |
| `demag_kind="periodic_airbox_k0"` | Evaluates $\mathbf k=0$ thin-film sheet demagnetization ($N_z \approx 1$) from the shared-domain periodic airbox Poisson operator. | It is not identical to an open finite-element box where lateral demagnetizing factors $N_x, N_y > 0$ shift the Kittel frequency. |
| `demag_kind="synthetic_demag_factor"` | Applies explicit diagonal demagnetizing factors $(N_x, N_y, N_z)$ for exact macrospin Kittel verification (`solve_k0_kittel_synthetic_demag_factor_single_k`). | It is a controlled operator-verification path, not a substitute for 3D finite-element Poisson airbox demagnetization. |
| `relative_tolerance` / `max_relative_error` | Bounds the maximum permitted relative frequency deviation $\max_j \varepsilon_j \le \varepsilon_{\max}$ (capped at $0.25$). | A passing frequency error does not replace coupled residual certification $(r_q, r_\phi)$ or mesh convergence evidence. |

(numerical-methods-modal-validation-python-api)=
## Python API

```python
# %% Attach reproducible DE/BV dispersion and k=0 Kittel validation intent to a stage-first study
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

# %% Thin-film Damon-Eshbach and backward-volume dispersion validation contract
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

# %% Zero-wave-vector Kittel bias-field sweep validation contract
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

## Parameters

### `ThinFilmDEBVDispersionValidation` and `DispersionValidationScenario` parameters

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
| `DispersionValidationScenario.geometry` | `str` | required | $1$ | `damon_eshbach` or `backward_volume` | propagation geometry relative to $\mathbf m_0$ | FEM validation | `runtime_metadata.dispersion_validation.scenarios[].geometry` |
| `DispersionValidationScenario.branch_id` | `str` | required | $1$ | non-empty string | tracked branch identifier | FEM validation | `runtime_metadata.dispersion_validation.scenarios[].branch_id` |
| `DispersionValidationScenario.sample_indices` | `tuple[int,...]` | required | $1$ | non-empty nonnegative integers | path sample indices for scenario | FEM validation | `runtime_metadata.dispersion_validation.scenarios[].sample_indices` |

### `K0KittelFieldSweepValidation` and `K0KittelFieldSample` parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `K0KittelFieldSweepValidation.samples` | `Sequence[K0KittelFieldSample]` | required | $1$ | at least three unique samples | bias-field sweep samples | FEM validation | `runtime_metadata.k0_kittel_validation.samples` |
| `K0KittelFieldSweepValidation.model` | `str` | `macrospin_larmor` | $1$ | `macrospin_larmor` or `thin_film_in_plane` | Kittel model | FEM validation | `runtime_metadata.k0_kittel_validation.model` |
| `K0KittelFieldSweepValidation.effective_magnetisation` | `float | None` | `None` | $\mathrm{A\,m^{-1}}$ | positive when required by model | effective magnetization | FEM validation | `runtime_metadata.k0_kittel_validation.material.effective_magnetisation` |
| `K0KittelFieldSweepValidation.relative_tolerance` | `float` | `0.05` | $1$ | positive and at most `0.25` | permitted Kittel error | FEM validation | `runtime_metadata.k0_kittel_validation.relative_tolerance` |
| `K0KittelFieldSweepValidation.case_id` | `str | None` | `None` | $1$ | nonempty when supplied | reproducible case identity | all validation | `runtime_metadata.k0_kittel_validation.case_id` |
| `K0KittelFieldSweepValidation.demag_kind` | `str | None` | `None` | $1$ | `none`, `periodic_airbox_k0`, or `synthetic_demag_factor` | demag assumption | FEM validation | `runtime_metadata.k0_kittel_validation.demag_kind` |
| `K0KittelFieldSweepValidation.demag_factors` | `tuple[float,float,float] | None` | `None` | $1$ | finite nonnegative triad summing to $1$ | diagonal demagnetizing factors $(N_x,N_y,N_z)$ | FEM validation | `runtime_metadata.k0_kittel_validation.demag_factors` |
| `K0KittelFieldSample.sample_index` | `int` | required | $1$ | nonnegative unique integer | sweep sample index | FEM validation | `runtime_metadata.k0_kittel_validation.samples[].sample_index` |
| `K0KittelFieldSample.bias_field` | `tuple[float,float,float]` | required | $\mathrm{A\,m^{-1}}$ | finite nonzero three-vector | static external field $\mathbf H_j$ | FEM validation | `runtime_metadata.k0_kittel_validation.samples[].bias_field` |

(numerical-methods-modal-validation-problem-ir)=
## ProblemIR and provenance

Validation contracts are lowered into `runtime_metadata.dispersion_validation` and
`runtime_metadata.k0_kittel_validation` inside `ProblemIR`, keeping validation intent distinct from
the modal study specification:

```json
{
  "runtime_metadata": {
    "dispersion_validation": {
      "schema": "fem_thin_film_de_bv_dispersion_v1",
      "analytic_model": "kalinikos_slab_n0",
      "film_thickness_m": 3e-9,
      "equilibrium_magnetization": [1.0, 0.0, 0.0],
      "film_normal": [0.0, 0.0, 1.0],
      "frequency_window_hz": [0.0, 5000000000.0],
      "max_k_rad_per_m": 3000000.0,
      "max_relative_error": 0.1,
      "scenarios": [
        {"geometry": "damon_eshbach", "branch_id": "branch_0", "sample_indices": [0, 1, 2]},
        {"geometry": "backward_volume", "branch_id": "branch_0", "sample_indices": [3, 4, 5]}
      ]
    },
    "k0_kittel_validation": {
      "schema": "fem_k0_kittel_field_sweep_v1",
      "case_id": "k0-macrospin",
      "model": "macrospin_larmor",
      "relative_tolerance": 0.05,
      "samples": [
        {"sample_index": 0, "bias_field": [8000.0, 0.0, 0.0]},
        {"sample_index": 1, "bias_field": [10000.0, 0.0, 0.0]},
        {"sample_index": 2, "bias_field": [12000.0, 0.0, 0.0]}
      ]
    }
  }
}
```

During execution, `append_eigen_path_k0_kittel_validation_artifacts` and
`build_native_field_sweep_artifact` evaluate the analytical formulas against the tracked numerical
branches and record per-sample computed frequencies, reference frequencies, signed shifts
$\Delta f_j$, relative errors $\varepsilon_j$, coupled residuals $\varepsilon_{\mathrm{eig},n}$,
and pass/fail status in the run provenance.

(numerical-methods-modal-validation-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

Script export preserves validation objects and stage ordering. The **requested intent** and
**resolved execution** are stored separately. Constructor and planner checks raise immediate
**validation errors** for missing Damon–Eshbach or backward-volume geometries, fewer than three
unique Kittel field samples, duplicate sample indices, missing `effective_magnetisation` when
`model="thin_film_in_plane"`, `demag_factors` not summing to unity, or tolerances exceeding `0.25`.
**Unsupported combinations** are rejected explicitly before solve execution; attaching validation
metadata never qualifies an unsupported backend or bypasses native residual certification.

(numerical-methods-modal-validation-discrete-realization)=
## Discrete realization by lane

| Solver | Device | Status | Realization |
|---|---|---|---|
| FEM | CPU | `source-backed` | Native modal spectra, tracked dispersion branches, and $\mathbf k=0$ field sweeps compared against Kalinikos–Slavin and Kittel analytical references |
| FEM | GPU | `partial` | Consumes GPU modal spectra (`solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`, `solve_poisson_airbox_modal_eigen_gpu_device_krylov`) only after device-execution identity is proven |
| FDM | CPU | `unsupported` | No native FDM modal lane is claimed |
| FDM | GPU | `unsupported` | No native CUDA FDM modal lane is claimed |

### 8.1 Validation execution sequence

1. **Schema & domain validation**: Python constructors (`ThinFilmDEBVDispersionValidation`,
   `K0KittelFieldSweepValidation`) and `validate_bias_field_sweep_oracle_contract` verify sample
   counts, geometry coverage, and demagnetization assumptions.
2. **Equilibrium & V6 certificate binding**: `build_owned_modal_certificate_v6_binding` certifies
   $\mathbf m_0$, periodic seam pairings, and shared-domain index maps.
3. **Modal solve & residual certification**: `solve_modal_eigen_contract`,
   `evaluate_poisson_airbox_modal_residuals`, `apply_poisson_airbox_modal_residual_certification`,
   and `certify_floquet_realified_mode` verify that every candidate mode satisfies both the coupled
   descriptor residual gate and the shifted-KSP true-residual gate (`floquet_shifted_true_convergence_test`).
4. **Branch tracking**: `track_branches` connects modes across $\mathbf k$ or $\mathbf H_j$ samples
   using `ConsistentP1TrackingMetric`.
5. **Analytical comparison & artifact publication**: `append_eigen_path_k0_kittel_validation_artifacts`,
   `eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts`, and
   `build_native_field_sweep_artifact` compute $f_j^{\mathrm{ref}}$, $\Delta f_j$, and
   $\varepsilon_j$ and publish the qualification report.

(numerical-methods-modal-validation-implementation-mapping)=
## Where this is implemented

All source links below point to the reviewed revision `5e99782acbb7fb3f65d0cad872e102bf67733103`.

| Claim | Repository path | Stable symbol | Responsibility | Lane |
|---|---|---|---|---|
| Dispersion scenario schema | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L222) | `class DispersionValidationScenario` | Validates individual DE/BV branch-sample scenarios | Python |
| Dispersion validation schema | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L244) | `class ThinFilmDEBVDispersionValidation` | Validates and serializes Kalinikos–Slavin DE/BV dispersion cases | Python |
| Kittel sample schema | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L311) | `class K0KittelFieldSample` | Validates individual bias-field sweep samples | Python |
| Kittel validation schema | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L332) | `class K0KittelFieldSweepValidation` | Validates and serializes $\mathbf k=0$ Kittel field sweeps | Python |
| FEM modal planner | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L5155) | `plan_fem_eigen` | Resolves `FemEigenPlanIR` and validation metadata | Planner |
| Kittel artifact publisher | [`crates/fullmag-runner/src/fem/eigen_path.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L970) | `append_eigen_path_k0_kittel_validation_artifacts` | Appends $\mathbf k=0$ Kittel comparison metrics to modal artifacts | Runner |
| Periodic airbox $\mathbf k=0$ metrics | [`crates/fullmag-runner/src/fem/eigen_path.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L993) | `eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts` | Evaluates periodic-airbox $\mathbf k=0$ thin-film Kittel metrics | Runner |
| Synthetic demag-factor solver | [`crates/fullmag-runner/src/fem/eigen_path.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L1004) | `solve_k0_kittel_synthetic_demag_factor_single_k` | Executes synthetic $(N_x,N_y,N_z)$ Kittel verification | Runner |
| Field-sweep oracle contract | [`crates/fullmag-runner/src/fem/eigen_sweep.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_sweep.rs#L176) | `validate_bias_field_sweep_oracle_contract` | Validates field-sweep Kittel oracle inputs and tolerances | Runner |
| Field-sweep artifact builder | [`crates/fullmag-runner/src/fem/eigen_sweep.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_sweep.rs#L915) | `build_native_field_sweep_artifact` | Assembles multi-sample field-sweep spectra and Kittel errors | Runner |
| Mass-weighted branch tracking | [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | `track_branches` | Matches mode branches across $\mathbf k$ and bias-field steps | Runner |
| $P_1$ mass tracking metric | [`crates/fullmag-runner/src/eigen/tracking_mass.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | `ConsistentP1TrackingMetric` | Consistent $P_1$ finite-element inner product for mode overlap | Runner |
| V6 modal certificate | [`crates/fullmag-runner/src/fem/eigen_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1188) | `build_owned_modal_certificate_v6_binding` | Cryptographic V6 binding of equilibrium, mesh, and seam maps | Runner |
| Modal solver contract | [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2134) | `solve_modal_eigen_contract` | Native modal diagnostics and execution status | FEM CPU/GPU |
| Coupled residual evaluation | [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L648) | `evaluate_poisson_airbox_modal_residuals` | Evaluates coupled $(r_q, r_\phi)$ residuals | FEM CPU |
| Residual certification | [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L658) | `apply_poisson_airbox_modal_residual_certification` | Enforces coupled residual acceptance criteria | FEM CPU |
| Floquet mode certification | [`backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L98) | `certify_floquet_realified_mode` | Certifies complex Floquet eigenmodes reconstructed from real-split pencils | FEM CPU |
| Shifted-KSP convergence gate | [`backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp#L500) | `floquet_shifted_true_convergence_test` | Verifies true unpreconditioned KSP residuals inside shift-and-invert | FEM CPU |

(numerical-methods-modal-validation-validation)=
## Validation

| Validation layer | Required check | Evidence required |
|---|---|---|
| Equilibrium & V6 certificate | Static torque below `tolT`, $\|\mathbf m_{0,i}\|=1$, and immutable equilibrium across $\mathbf k$ samples. | `OwnedModalCertificateV6Binding` digest and equilibrium handoff provenance. |
| Coupled algebraic residual | Both magnetic block residual $\|r_{q,n}\|_2$ and Poisson residual $\|r_{\phi,n}\|_2$ satisfy solver tolerance. | `evaluate_poisson_airbox_modal_residuals` and `apply_poisson_airbox_modal_residual_certification` telemetry. |
| Real-split Floquet lifting | Complex mode reconstructed from the $2n\times 2n$ rotated real-split pencil satisfies the complex Floquet descriptor. | `certify_floquet_realified_mode` and `floquet_shifted_true_convergence_test`. |
| $\mathbf k=0$ Kittel sweep | $\max_j |f_j^{\mathrm{num}} - f_{\mathrm{Kittel}}(\mathbf H_j)| / f_{\mathrm{Kittel}}(\mathbf H_j) \le \varepsilon_{\max}$ across $\ge 3$ bias fields. | `K0KittelFieldSweepValidation` report produced by `append_eigen_path_k0_kittel_validation_artifacts`. |
| Thin-film DE/BV dispersion | Both Damon–Eshbach and backward-volume branches match $f_{\mathrm{KS}}(\mathbf k)$ within `max_relative_error`. | `ThinFilmDEBVDispersionValidation` report and tracked branch overlaps $\mathcal O_{ab}$ in `eigen/branches.v2.json`. |

(numerical-methods-modal-validation-limitations)=
## Limitations

Analytical agreement on $\mathbf k=0$ Kittel sweeps or thin-film $n=0$ Kalinikos–Slavin dispersions
qualifies the solver only within the declared parameter regime ($k \le 3\times 10^6\,\mathrm{rad\,m^{-1}}$,
$f \le 5\,\mathrm{GHz}$ in the default thin-film validator). It does not replace mesh-refinement and
airbox-truncation convergence studies for thick, strongly inhomogeneous, or 3D nanostructures.

(numerical-methods-modal-validation-scientific-bibliography)=
## Scientific bibliography

1. C. Kittel, “On the theory of ferromagnetic resonance absorption,” *Physical Review* **73**,
   155–161 (1948), [doi:10.1103/PhysRev.73.155](https://doi.org/10.1103/PhysRev.73.155).
2. R. W. Damon and J. R. Eshbach, “Magnetostatic modes of a ferromagnet slab,” *Journal of Physics
   and Chemistry of Solids* **19**, 308–320 (1961),
   [doi:10.1016/0022-3697(61)90041-5](https://doi.org/10.1016/0022-3697(61)90041-5).
3. B. A. Kalinikos and A. N. Slavin, “Theory of dipole-exchange spin wave spectrum for
   ferromagnetic films with mixed exchange boundary conditions,” *Journal of Physics C: Solid State
   Physics* **19**, 7013–7033 (1986),
   [doi:10.1088/0022-3719/19/35/014](https://doi.org/10.1088/0022-3719/19/35/014).
4. Canonical modal solver owner: {doc}`linearized-llg`.

(numerical-methods-modal-validation-source-code-index)=

## Control Room workflow

Use `Model Explorer -> Stages -> Add stage -> Eigenmodes` for stage-level modal controls, and
inspect post-solve residual summaries and modal-vs-driven FMR comparisons through
`eigenResidualSummary.ts` (`buildEigenResidualSummary`) and `frequencyDomainChartModels.ts`
(`buildFmrModalDrivenComparisonModel`, `buildEigenDispersionChartModel`). Typed analytical validation
contracts (`study.dispersion_validation(...)` and `study.k0_kittel_validation(...)`) are authored in
the canonical Python script. See {doc}`/frontend/capability-register` for the current register and
exact source owner.

## Source-code index

| Claim | Repository path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Dispersion scenario schema | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L222) | `class DispersionValidationScenario` | DE/BV branch-sample scenario schema | Python source |
| Dispersion schema | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L244) | `class ThinFilmDEBVDispersionValidation` | Typed Kalinikos–Slavin validation payload | Python source |
| Kittel sample schema | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L311) | `class K0KittelFieldSample` | Bias-field sample schema | Python source |
| Kittel schema | [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L332) | `class K0KittelFieldSweepValidation` | Typed $\mathbf k=0$ Kittel validation payload | Python source |
| FEM modal planner | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L5155) | `plan_fem_eigen` | Planner validation and `FemEigenPlanIR` construction | Rust planner source |
| Kittel artifact publisher | [`crates/fullmag-runner/src/fem/eigen_path.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L970) | `append_eigen_path_k0_kittel_validation_artifacts` | Appends Kittel validation artifacts | Rust runner source |
| Periodic airbox $\mathbf k=0$ | [`crates/fullmag-runner/src/fem/eigen_path.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L993) | `eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts` | Periodic-airbox $\mathbf k=0$ Kittel metrics | Rust runner source |
| Synthetic demag-factor solve | [`crates/fullmag-runner/src/fem/eigen_path.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L1004) | `solve_k0_kittel_synthetic_demag_factor_single_k` | Synthetic $(N_x,N_y,N_z)$ Kittel verification | Rust runner source |
| Field-sweep oracle check | [`crates/fullmag-runner/src/fem/eigen_sweep.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_sweep.rs#L176) | `validate_bias_field_sweep_oracle_contract` | Validates field-sweep Kittel oracle contract | Rust runner source |
| Field-sweep artifact builder | [`crates/fullmag-runner/src/fem/eigen_sweep.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_sweep.rs#L915) | `build_native_field_sweep_artifact` | Builds field-sweep validation artifact | Rust runner source |
| Mass-weighted tracking | [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | `track_branches` | Mass-weighted Hungarian mode tracking | Rust runner source |
| $P_1$ mass metric | [`crates/fullmag-runner/src/eigen/tracking_mass.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | `ConsistentP1TrackingMetric` | Consistent $P_1$ mass inner product | Rust runner source |
| V6 modal certificate | [`crates/fullmag-runner/src/fem/eigen_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1188) | `build_owned_modal_certificate_v6_binding` | V6 equilibrium and seam-map certificate | Rust runner source |
| Native modal diagnostics | [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2134) | `solve_modal_eigen_contract` | Solver status and diagnostics | Native C++ source |
| Coupled residual evaluation | [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L648) | `evaluate_poisson_airbox_modal_residuals` | Evaluates coupled $(r_q, r_\phi)$ residuals | Native C++ header |
| Residual certification | [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L658) | `apply_poisson_airbox_modal_residual_certification` | Enforces coupled residual acceptance criteria | Native C++ header |
| Floquet mode certification | [`backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L98) | `certify_floquet_realified_mode` | Certifies real-split Floquet modes | Native C++ header |
| Shifted-KSP convergence gate | [`backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp#L500) | `floquet_shifted_true_convergence_test` | True residual gate for shifted KSP | Native C++ header |
