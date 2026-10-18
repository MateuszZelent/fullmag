---
title: Modal Validation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0600-fem-eigenmodes-linearized-llg.md
---

(public-docs-numerical-methods-eigensolvers-modal-validation)=
(numerical-methods-eigensolvers-modal-validation)=
# Modal validation and dispersion qualification

This chapter specifies the analytical reference models, algebraic residual gates, and branch-overlap
metrics used to qualify the FEM linearized LLG eigensolver in FullMag. A modal run is not
considered scientifically qualified merely because the eigensolver returns $K$ eigenvalues: every
accepted run must simultaneously satisfy inner shifted KSP convergence, full coupled $(q,\phi)$
descriptor residual tolerances, cryptographic equilibrium certificate binding, and—for benchmark
problems—quantitative agreement with analytical Kittel or Kalinikos–Slavin dispersion relations.

(modal-validation-problem-statement)=
## 1. Physical problem and modal qualification scope

Validation of the FEM modal solver separates three independent sources of numerical error:

1. **Algebraic eigensolver error**: measured by the unreduced $(q,\phi)$ descriptor residual
   $\varepsilon_{\mathrm{eig},n}$ and the unpreconditioned inner shifted Krylov residual;
2. **Spatial and exterior-airbox discretization error**: measured by convergence of the $\mathbf k = \mathbf 0$
   ferromagnetic resonance (FMR) frequency against analytical macrospin Larmor, thin-film in-plane,
   and ellipsoidal Kittel formulas across a static bias-field sweep (`K0KittelFieldSweepValidation`);
3. **Bloch–Floquet and dipole-exchange dispersion error**: measured by comparing tracked Damon–Eshbach
   (DE, $\mathbf k \perp \mathbf m_0$) and backward-volume (BV, $\mathbf k \parallel \mathbf m_0$)
   spin-wave branches against the lowest ($n=0$) Kalinikos–Slavin analytical thin-film slab
   dispersion (`ThinFilmDEBVDispersionValidation`).

(modal-validation-governing-equations)=
## 2. Governing analytical and algebraic validation equations

### 2.1 Pointwise relative frequency error gate

For any discrete validation sample $j \in \{1,\dots,N_{\mathrm{samp}}\}$ (indexing either a wave-vector
sample $\mathbf k_j$ or a static bias field $\mathbf H_j$), the dimensionless relative frequency
discrepancy between the numerically computed branch frequency $f_j^{\mathrm{num}}$ and the
analytical reference $f_j^{\mathrm{ref}}$ must satisfy:

```{math}
:label: eq-numerical-modal-validation-relative-error
\varepsilon_j
=
\frac{\bigl\lvert f_j^{\mathrm{num}} - f_j^{\mathrm{ref}} \bigr\rvert}{\bigl\lvert f_j^{\mathrm{ref}} \bigr\rvert}
\le \varepsilon_{\max}.
```

### 2.2 Uniform-mode ($\mathbf k = \mathbf 0$) Kittel bias-field sweep models

Across a static external field sweep $\{\mathbf H_j\}$, the signed frequency residual and maximum
relative Kittel error are:

```{math}
:label: eq-numerical-modal-validation-kittel
\Delta f_j = f_j^{\mathrm{num}} - f_{\mathrm{Kittel}}(\mathbf H_j),
\qquad
\max_j \frac{\lvert\Delta f_j\rvert}{f_{\mathrm{Kittel}}(\mathbf H_j)} \le \varepsilon_{\max}.
```

Depending on `K0KittelFieldSweepValidation.model` and `demag_kind`, the analytical oracle
$f_{\mathrm{Kittel}}(\mathbf H_j)$ evaluates one of three closed-form expressions for a magnet
saturated along $x$ by an internal collinear field $H_0$:

```{math}
:label: eq-numerical-modal-validation-kittel-models
f_{\mathrm{Larmor}}(H_0) = \frac{\gamma_0}{2\pi}H_0,
\qquad
f_{\mathrm{film}}(H_0) = \frac{\gamma_0}{2\pi}\sqrt{H_0\bigl(H_0 + M_{\mathrm{eff}}\bigr)},
\qquad
f_{\mathrm{demag}}(H_0) = \frac{\gamma_0}{2\pi}\sqrt{\bigl(H_0 + (N_y - N_x)M_s\bigr)\bigl(H_0 + (N_z - N_x)M_s\bigr)}.
```

Here $\gamma_0 = \mu_0\lvert\gamma\rvert$ (in $\mathrm{m\,A^{-1}\,s^{-1}}$), $M_{\mathrm{eff}}$ is
the effective thin-film demagnetizing magnetization ($M_{\mathrm{eff}} = M_s$ for an ideal
unstrained periodic film normal to $\hat{\mathbf z}$), and $(N_x, N_y, N_z)$ are the diagonal
macroscopic demagnetizing factors satisfying $N_x + N_y + N_z = 1$.

### 2.3 Kalinikos–Slavin dipole-exchange thin-film dispersion ($n = 0$)

For an in-plane magnetized ferromagnetic film of thickness $d$, saturation magnetization $M_s$,
exchange length $\ell_{\mathrm{ex}} = \sqrt{2A_{\mathrm{ex}}/(\mu_0 M_s^2)}$, and in-plane wave
vector $\mathbf k$ of magnitude $k = \lvert\mathbf k\rvert$ at angle $\varphi_{\mathbf k}$ relative
to $\mathbf m_0$, `ThinFilmDEBVDispersionValidation` (`analytic_model="kalinikos_slab_n0"`)
evaluates the unpinned ($n=0$) Kalinikos–Slavin dispersion relation:

```{math}
:label: eq-numerical-modal-validation-kalinikos-slavin
f_{\mathrm{KS}}(k, \varphi_{\mathbf k})
= \frac{\gamma_0}{2\pi}\sqrt{\Bigl(H_0 + M_s\ell_{\mathrm{ex}}^2 k^2 + M_s\bigl(1 - P_{00}(kd)\bigr)\sin^2\varphi_{\mathbf k}\Bigr)\Bigl(H_0 + M_s\ell_{\mathrm{ex}}^2 k^2 + M_s P_{00}(kd)\Bigr)},
\qquad
P_{00}(kd) = 1 - \frac{1 - \mathrm e^{-kd}}{kd}.
```

In the backward-volume geometry (`geometry="backward_volume"`, $\varphi_{\mathbf k} = 0$),
$\sin^2\varphi_{\mathbf k} = 0$ and the group velocity is negative at small $kd$. In the
Damon–Eshbach geometry (`geometry="damon_eshbach"`, $\varphi_{\mathbf k} = \pi/2$),
$\sin^2\varphi_{\mathbf k} = 1$ and the dipolar term produces a positive initial slope
$\partial f_{\mathrm{KS}}/\partial k|_{k\to 0^+} > 0$.

### 2.4 Coupled $(q,\phi)$ descriptor residual and mass-weighted mode overlap

Every candidate eigenmode $(\lambda_n, \mathbf q_n)$ with reconstructed potential
$\boldsymbol\phi_n = -P^{-1}A_{\phi q}\mathbf q_n$ is certified by
`evaluate_poisson_airbox_modal_residuals`, `apply_poisson_airbox_modal_residual_certification`, and
`certify_floquet_realified_mode`, while branch continuity across steps is certified by the
consistent-$P_1$ mass-weighted overlap $\mathcal O_{ab}$:

```{math}
:label: eq-numerical-modal-validation-overlap
\varepsilon_{\mathrm{eig},n} = \frac{\sqrt{r_{q,n}^2 + (\mu_0 M_s\,r_{\phi,n})^2}}{\lVert A_{qq}\mathbf q_n\rVert_2 + \lvert\lambda_n\rvert\,\lVert B_{qq}\mathbf q_n\rVert_2},
\qquad
r_{q,n} = \bigl\lVert A_{qq}\mathbf q_n + A_{q\phi}\boldsymbol\phi_n - \lambda_n B_{qq}\mathbf q_n \bigr\rVert_2,
\qquad
r_{\phi,n} = \bigl\lVert A_{\phi q}\mathbf q_n + P\boldsymbol\phi_n \bigr\rVert_2,
\qquad
\mathcal O_{ab} = \frac{\bigl\lvert \mathbf q_a^H (M \otimes I_2) \mathbf q_b \bigr\rvert}{\sqrt{\mathbf q_a^H (M \otimes I_2) \mathbf q_a}\,\sqrt{\mathbf q_b^H (M \otimes I_2) \mathbf q_b}}.
```

(modal-validation-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $f_j^{\mathrm{num}}$ | computed modal eigenfrequency at validation sample $j$ | $\mathrm{Hz}$ |
| $f_j^{\mathrm{ref}}$ | analytical or reference eigenfrequency at sample $j$ | $\mathrm{Hz}$ |
| $\varepsilon_j$ | dimensionless relative eigenfrequency error at sample $j$ | $1$ |
| $\varepsilon_{\max}$ | maximum permitted relative eigenfrequency error | $1$ |
| $f_{\mathrm{Kittel}}$ | analytical Kittel ferromagnetic-resonance frequency | $\mathrm{Hz}$ |
| $\mathbf H_j$ | external static bias magnetic field at sweep sample $j$ | $\mathrm{A\,m^{-1}}$ |
| $\Delta f_j$ | signed eigenfrequency residual $f_j^{\mathrm{num}} - f_{\mathrm{Kittel}}(\mathbf H_j)$ | $\mathrm{Hz}$ |
| $j$ | discrete validation sample index | $1$ |
| $H_0$ | collinear internal static magnetic field magnitude | $\mathrm{A\,m^{-1}}$ |
| $M_{\mathrm{eff}}$ | effective thin-film demagnetizing magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\gamma_0$ | rescaled gyromagnetic prefactor $\mu_0\lvert\gamma\rvert$ | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $f_{\mathrm{Larmor}}$ | isotropic macrospin Larmor precession frequency | $\mathrm{Hz}$ |
| $f_{\mathrm{film}}$ | in-plane magnetized thin-film Kittel FMR frequency | $\mathrm{Hz}$ |
| $f_{\mathrm{demag}}$ | general triaxial ellipsoidal Kittel FMR frequency | $\mathrm{Hz}$ |
| $N_x, N_y, N_z$ | diagonal macroscopic demagnetizing tensor factors ($N_x+N_y+N_z=1$) | $1$ |
| $f_{\mathrm{KS}}(k, \varphi_{\mathbf k})$ | Kalinikos–Slavin lowest ($n=0$) dipole-exchange spin-wave frequency | $\mathrm{Hz}$ |
| $P_{00}(kd)$ | Kalinikos–Slavin thickness-averaged dipolar form factor | $1$ |
| $d$ | ferromagnetic film thickness | $\mathrm{m}$ |
| $\ell_{\mathrm{ex}}$ | micromagnetic exchange length $\sqrt{2A_{\mathrm{ex}}/(\mu_0 M_s^2)}$ | $\mathrm{m}$ |
| $k$ | in-plane spin-wave wave-vector magnitude | $\mathrm{rad\,m^{-1}}$ |
| $\varphi_{\mathbf k}$ | angle between in-plane wave vector $\mathbf k$ and equilibrium $\mathbf m_0$ | $\mathrm{rad}$ |
| $\varepsilon_{\mathrm{eig},n}$ | dimensionless relative coupled eigenpair residual for mode $n$ | $1$ |
| $r_{q,n}$ | Euclidean norm of the magnetic block residual for mode $n$ | $\mathrm{J}$ |
| $r_{\phi,n}$ | Euclidean norm of the Poisson flux-continuity residual for mode $n$ | $\mathrm{A\,m}$ |
| $A_{qq}$ | assembled tangent-plane micromagnetic energy-Hessian stiffness block | $\mathrm{J}$ |
| $A_{q\phi}$ | assembled magnetic-to-potential Zeeman gradient coupling block | $\mathrm{J\,A^{-1}}$ |
| $A_{\phi q}$ | assembled potential-to-magnetic flux divergence coupling block | $\mathrm{A\,m}$ |
| $P$ | shared-domain magnetic-plus-airbox Poisson stiffness matrix | $\mathrm{m}$ |
| $B_{qq}$ | descriptor right-hand gyrotropic operator block $-G$ | $\mathrm{J\,s}$ |
| $\mathbf q_n$ | discrete tangent-plane eigenvector for mode $n$ | $1$ |
| $\boldsymbol\phi_n$ | reconstructed discrete dynamic scalar potential vector for mode $n$ | $\mathrm{A}$ |
| $\lambda_n$ | complex modal eigenvalue for mode $n$ | $\mathrm{s^{-1}}$ |
| $M$ | consistent $P_1$ finite-element volume mass matrix on $\Omega_m$ | $\mathrm{m^3}$ |
| $\mathcal O_{ab}$ | normalized mass-weighted mode overlap inner product | $1$ |

(modal-validation-assumptions-and-validity)=
## 4. Assumptions, boundary meaning, and validity limits

| Validation contract | Mathematical regime | Validity limit |
|---|---|---|
| `model="macrospin_larmor"` | Pure Zeeman precession without dipolar shape anisotropy ($N_x=N_y=N_z$). | Invalid when `include_demag=True` on an anisotropic geometry. |
| `model="thin_film_in_plane"` | Laterally periodic thin film at $\mathbf k = \mathbf 0$ with $N_\perp = 1, N_\parallel = 0$. | Requires periodic lateral boundary conditions and sufficient airbox padding along the film normal. |
| `demag_kind="synthetic_demag_factor"` | Diagonal demagnetizing tensor $(N_x,N_y,N_z)$ injected into the local stiffness operator. | Verifies the tangent $2\times 2$ algebra independently of airbox truncation error. |
| `analytic_model="kalinikos_slab_n0"` | Unpinned lowest thickness mode ($kd \ll 1$) of an infinite in-plane magnetized slab. | Restricted to $k \le 3\times 10^6\,\mathrm{rad\,m^{-1}}$ and $f \le 5\,\mathrm{GHz}$ in the schema contract; does not apply to thick films with strong vertical mode hybridization. |

(modal-validation-python-api)=
## 5. Python API and complete parameter reference

### Executable stage workflow

The following copyable example constructs both a $\mathbf k = \mathbf 0$ Kittel bias-field sweep
validation schema and a thin-film Damon–Eshbach / backward-volume Kalinikos–Slavin dispersion
validation schema, and attaches them to a FEM modal study.

```python
# %% Imports and validation schema construction
import fullmag as fm

kittel_validation = fm.K0KittelFieldSweepValidation(
    case_id="permalloy_thin_film_k0_fmr",
    model="thin_film_in_plane",
    demag_kind="periodic_airbox_k0",
    effective_magnetisation=8.0e5,
    relative_tolerance=0.03,
    samples=[
        fm.K0KittelFieldSample(sample_index=0, bias_field=(2.0e4, 0.0, 0.0)),
        fm.K0KittelFieldSample(sample_index=1, bias_field=(4.0e4, 0.0, 0.0)),
        fm.K0KittelFieldSample(sample_index=2, bias_field=(8.0e4, 0.0, 0.0)),
    ],
)

dispersion_validation = fm.ThinFilmDEBVDispersionValidation(
    film_thickness_m=10.0e-9,
    equilibrium_magnetization=(1.0, 0.0, 0.0),
    film_normal=(0.0, 0.0, 1.0),
    frequency_window_hz=(0.0, 5.0e9),
    max_k_rad_per_m=3.0e6,
    max_relative_error=0.08,
    analytic_model="kalinikos_slab_n0",
    scenarios=[
        fm.DispersionValidationScenario(
            geometry="backward_volume",
            branch_id="branch_0",
            sample_indices=(0, 1, 2, 3),
        ),
        fm.DispersionValidationScenario(
            geometry="damon_eshbach",
            branch_id="branch_0",
            sample_indices=(4, 5, 6, 7),
        ),
    ],
)

# %% Attach validation contracts to a FEM modal study
nm = 1.0e-9
study = fm.study("fem_modal_qualification")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

film = study.geometry(
    fm.Box(size=(100 * nm, 100 * nm, 10 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.01
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

study.exchange()
study.zeeman(field=(4.0e4, 0.0, 0.0))
study.demag(model="airbox", variant="robin")
study.stages.add_relax(stage_id="relax", max_steps=5000, tolT=1.0e-8)
study.stages.add_eigenmodes(
    stage_id="eigen_qual",
    count=4,
    operator="full_2x2",
    include_demag=True,
    equilibrium_source="relax",
)
```

### Validation schema parameters

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `ThinFilmDEBVDispersionValidation.film_thickness_m` | `float` | `required` | $\mathrm{m}$ | positive | film thickness | FEM validation | `runtime_metadata.dispersion_validation.film_thickness_m` |
| `ThinFilmDEBVDispersionValidation.equilibrium_magnetization` | `tuple[float,float,float]` | `required` | $1$ | nonzero three-vector | equilibrium direction/magnitude input | FEM validation | `runtime_metadata.dispersion_validation.equilibrium_magnetization` |
| `ThinFilmDEBVDispersionValidation.scenarios` | `Sequence[DispersionValidationScenario]` | `required` | $1$ | must include both geometries | branch/sample cases | FEM validation | `runtime_metadata.dispersion_validation.scenarios` |
| `ThinFilmDEBVDispersionValidation.film_normal` | `tuple[float,float,float]` | `(0,0,1)` | $1$ | nonzero three-vector | film normal | FEM validation | `runtime_metadata.dispersion_validation.film_normal` |
| `ThinFilmDEBVDispersionValidation.frequency_window_hz` | `tuple[float,float]` | `(0,5e9)` | $\mathrm{Hz}$ | nonnegative lower, greater upper, upper at most $5$ GHz | validation frequency domain | FEM validation | `runtime_metadata.dispersion_validation.frequency_window_hz` |
| `ThinFilmDEBVDispersionValidation.max_k_rad_per_m` | `float` | `3e6` | $\mathrm{m^{-1}}$ | positive and at most $3e6$ | wave-vector bound | FEM validation | `runtime_metadata.dispersion_validation.max_k_rad_per_m` |
| `ThinFilmDEBVDispersionValidation.max_relative_error` | `float` | `0.10` | $1$ | positive and at most `0.25` | permitted dispersion error | FEM validation | `runtime_metadata.dispersion_validation.max_relative_error` |
| `ThinFilmDEBVDispersionValidation.analytic_model` | `str` | `kalinikos_slab_n0` | $1$ | currently `kalinikos_slab_n0` | analytical dispersion model | FEM validation | `runtime_metadata.dispersion_validation.analytic_model` |
| `DispersionValidationScenario.geometry` | `str` | `required` | $1$ | `damon_eshbach` or `backward_volume` | propagation geometry relative to $\mathbf m_0$ | FEM validation | `runtime_metadata.dispersion_validation.scenarios[].geometry` |
| `DispersionValidationScenario.branch_id` | `str` | `required` | $1$ | non-empty string | tracked branch identifier | FEM validation | `runtime_metadata.dispersion_validation.scenarios[].branch_id` |
| `DispersionValidationScenario.sample_indices` | `tuple[int,...]` | `required` | $1$ | non-empty nonnegative integers | path sample indices for scenario | FEM validation | `runtime_metadata.dispersion_validation.scenarios[].sample_indices` |
| `K0KittelFieldSweepValidation.samples` | `Sequence[K0KittelFieldSample]` | `required` | $1$ | at least three unique samples | bias-field sweep samples | FEM validation | `runtime_metadata.k0_kittel_validation.samples` |
| `K0KittelFieldSweepValidation.model` | `str` | `macrospin_larmor` | $1$ | `macrospin_larmor` or `thin_film_in_plane` | Kittel model | FEM validation | `runtime_metadata.k0_kittel_validation.model` |
| `K0KittelFieldSweepValidation.effective_magnetisation` | `float \| None` | `None` | $\mathrm{A\,m^{-1}}$ | positive when required by model | effective magnetization | FEM validation | `runtime_metadata.k0_kittel_validation.material.effective_magnetisation` |
| `K0KittelFieldSweepValidation.relative_tolerance` | `float` | `0.05` | $1$ | positive and at most `0.25` | permitted Kittel error | FEM validation | `runtime_metadata.k0_kittel_validation.relative_tolerance` |
| `K0KittelFieldSweepValidation.case_id` | `str \| None` | `None` | $1$ | nonempty when supplied | reproducible case identity | all validation | `runtime_metadata.k0_kittel_validation.case_id` |
| `K0KittelFieldSweepValidation.demag_kind` | `str \| None` | `None` | $1$ | `none`, `periodic_airbox_k0`, or `synthetic_demag_factor` | demag assumption | FEM validation | `runtime_metadata.k0_kittel_validation.demag_kind` |
| `K0KittelFieldSweepValidation.demag_factors` | `tuple[float,float,float] \| None` | `None` | $1$ | finite nonnegative triad summing to $1$ | diagonal demagnetizing factors $(N_x,N_y,N_z)$ | FEM validation | `runtime_metadata.k0_kittel_validation.demag_factors` |
| `K0KittelFieldSample.sample_index` | `int` | `required` | $1$ | nonnegative unique integer | sweep sample index | FEM validation | `runtime_metadata.k0_kittel_validation.samples[].sample_index` |
| `K0KittelFieldSample.bias_field` | `tuple[float,float,float]` | `required` | $\mathrm{A\,m^{-1}}$ | finite nonzero three-vector | static external field $\mathbf H_j$ | FEM validation | `runtime_metadata.k0_kittel_validation.samples[].bias_field` |

(modal-validation-problem-ir)=
## 6. ProblemIR, normalization, and provenance

Validation contracts serialize into `runtime_metadata.k0_kittel_validation` and
`runtime_metadata.dispersion_validation` inside `ProblemIR`:

```json
{
  "k0_kittel_validation": {
    "case_id": "permalloy_thin_film_k0_fmr",
    "model": "thin_film_in_plane",
    "demag_kind": "periodic_airbox_k0",
    "relative_tolerance": 0.03,
    "material": {
      "effective_magnetisation": 800000.0
    }
  }
}
```

(modal-validation-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

* **Requested intent**: preserves all authored sample indices, bias-field vectors, analytical model
  identifiers, and error tolerances across Python $\leftrightarrow$ `ProblemIR` serialization.
* **Resolved execution**: records per-sample numerical frequencies $f_j^{\mathrm{num}}$, analytical
  oracle frequencies $f_j^{\mathrm{ref}}$, relative errors $\varepsilon_j$, coupled residuals
  $(r_{q,n}, r_{\phi,n}, \varepsilon_{\mathrm{eig},n})$, and a boolean pass/fail qualification verdict.
* **Validation errors**: fail closed when `samples` contains fewer than 3 unique bias fields, when
  `ThinFilmDEBVDispersionValidation.scenarios` omits either `damon_eshbach` or `backward_volume`,
  when `demag_factors` do not sum to $1$, or when any sample violates $\varepsilon_j \le \varepsilon_{\max}$.
* **Unsupported combinations**: fail closed when a thin-film or periodic-airbox validation contract
  is attached to an incompatible mesh or non-FEM backend.

(modal-validation-discrete-realization)=
## 8. Discrete realization and execution sequence

1. **Contract preflight**: `plan_fem_eigen` and `validate_bias_field_sweep_oracle_contract` verify
   that the validation schema matches the study geometry, boundary conditions, and sampling points.
2. **Modal solve and algebraic certification**: for each sample $j$, the native solver runs
   `solve_modal_eigen_contract`, enforces `floquet_shifted_true_convergence_test`, and certifies
   each mode via `evaluate_poisson_airbox_modal_residuals`,
   `apply_poisson_airbox_modal_residual_certification`, and `certify_floquet_realified_mode`.
3. **Branch tracking**: `track_branches` and `ConsistentP1TrackingMetric` match mode branches across
   samples using the consistent-$P_1$ mass-weighted overlap $\mathcal O_{ab}$.
4. **Oracle evaluation and artifact emission**: `build_native_field_sweep_artifact`,
   `append_eigen_path_k0_kittel_validation_artifacts`,
   `eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts`, and
   `solve_k0_kittel_synthetic_demag_factor_single_k` compute $\varepsilon_j$ and write the
   qualification report.

(modal-validation-implementation-mapping)=
## 9. Implementation mapping

| Qualification responsibility | Python / Planner owner | Runner / Native C++ owner |
|---|---|---|
| Kittel field-sweep contract | `K0KittelFieldSweepValidation` and `plan_fem_eigen` | `validate_bias_field_sweep_oracle_contract` and `build_native_field_sweep_artifact` |
| Synthetic $(N_x,N_y,N_z)$ and periodic $\mathbf k=\mathbf 0$ checks | `K0KittelFieldSweepValidation` | `solve_k0_kittel_synthetic_demag_factor_single_k` and `eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts` |
| DE / BV Kalinikos–Slavin dispersion check | `ThinFilmDEBVDispersionValidation` and `DispersionValidationScenario` | `append_eigen_path_k0_kittel_validation_artifacts` and `track_branches` |
| Coupled $(q,\phi)$ and Floquet mode certification | `FemEigenSolverPolicy` | `evaluate_poisson_airbox_modal_residuals`, `apply_poisson_airbox_modal_residual_certification`, and `certify_floquet_realified_mode` |

(modal-validation-validation)=
## 10. Validation and qualification

| Qualification gate | Mathematical criterion | Required evidence |
|---|---|---|
| Coupled $(q,\phi)$ residual | $\varepsilon_{\mathrm{eig},n} \le \mathrm{tolerance}$ with reconstructed $\boldsymbol\phi_n = -P^{-1}A_{\phi q}\mathbf q_n$. | `apply_poisson_airbox_modal_residual_certification` pass flag. |
| Real-split Floquet mode | Complex residual of reconstructed Bloch mode satisfies $\lVert(L(\mathbf k) - \lambda_n B_\alpha)\mathbf q_n\rVert_2 \le \mathrm{tolerance}$. | `certify_floquet_realified_mode` receipt. |
| Kittel field sweep | $\max_j \lvert f_j^{\mathrm{num}} - f_{\mathrm{Kittel}}(\mathbf H_j)\rvert / f_{\mathrm{Kittel}}(\mathbf H_j) \le \varepsilon_{\max}$ across $\ge 3$ bias fields. | `build_native_field_sweep_artifact` JSON report. |
| DE / BV dispersion | Both $\mathbf k \perp \mathbf m_0$ (positive initial slope) and $\mathbf k \parallel \mathbf m_0$ (negative initial slope) satisfy $\varepsilon_j \le \varepsilon_{\max}$. | `ThinFilmDEBVDispersionValidation` scenario artifact. |

(modal-validation-limitations)=
## 11. Limitations and failure modes

* **Airbox truncation vs algebraic tolerance**: Tightening `FemEigenSolverPolicy.tolerance` reduces
  $\varepsilon_{\mathrm{eig},n}$ for the discretized mesh, but does not reduce magnetostatic airbox
  truncation error or coarse-mesh dispersion error.
* **Single-layer thin-film approximation**: The `kalinikos_slab_n0` oracle assumes a uniform
  through-thickness profile ($n=0$) and small $kd$; at larger $kd$ or in thicker films, perpendicular
  standing spin-wave (PSSW) hybridization causes physical deviation from the zeroth-order formula.

(modal-validation-scientific-bibliography)=
## 12. Scientific bibliography

1. C. Kittel, “On the theory of ferromagnetic resonance absorption,” *Physical Review*, 73, 155–161 (1948).
2. B. A. Kalinikos and A. N. Slavin, “Theory of dipole-exchange spin wave spectrum for ferromagnetic films with mixed exchange boundary conditions,” *Journal of Physics C: Solid State Physics*, 19, 7013–7033 (1986).
3. FullMag physics contracts: `docs/physics/0600-fem-eigenmodes-linearized-llg.md` and `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`.

(modal-validation-source-code-index)=
## 13. Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L222) | [`class DispersionValidationScenario`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L222) | DE/BV dispersion scenario schema. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L244) | [`class ThinFilmDEBVDispersionValidation`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L244) | Dispersion validation schema. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L311) | [`class K0KittelFieldSample`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L311) | Bias-field sweep sample schema. |
| [`packages/fullmag-py/src/fullmag/model/eigen.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L332) | [`class K0KittelFieldSweepValidation`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/eigen.py#L332) | Kittel field-sweep validation schema. |
| [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L5155) | [`plan_fem_eigen`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-plan/src/fem.rs#L5155) | Resolves FemEigenPlanIR and validation metadata. |
| [`crates/fullmag-runner/src/fem/eigen_path.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L970) | [`append_eigen_path_k0_kittel_validation_artifacts`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L970) | Appends k=0 Kittel validation comparison artifacts. |
| [`crates/fullmag-runner/src/fem/eigen_path.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L993) | [`eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L993) | Computes periodic-airbox k=0 thin-film Kittel metrics. |
| [`crates/fullmag-runner/src/fem/eigen_path.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L1004) | [`solve_k0_kittel_synthetic_demag_factor_single_k`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_path.rs#L1004) | Executes synthetic (Nx,Ny,Nz) Kittel verification. |
| [`crates/fullmag-runner/src/fem/eigen_sweep.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_sweep.rs#L176) | [`validate_bias_field_sweep_oracle_contract`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_sweep.rs#L176) | Validates field-sweep Kittel oracle inputs and tolerances. |
| [`crates/fullmag-runner/src/fem/eigen_sweep.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_sweep.rs#L915) | [`build_native_field_sweep_artifact`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_sweep.rs#L915) | Assembles field-sweep spectra and Kittel error reports. |
| [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | [`track_branches`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | Matches mode branches across k and bias-field steps. |
| [`crates/fullmag-runner/src/eigen/tracking_mass.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | [`ConsistentP1TrackingMetric`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking_mass.rs#L7) | Consistent P1 finite-element inner product for mode overlap. |
| [`crates/fullmag-runner/src/fem/eigen_certificate.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1188) | [`build_owned_modal_certificate_v6_binding`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/fem/eigen_certificate.rs#L1188) | Cryptographic V6 binding of equilibrium, mesh, and seam maps. |
| [`backends/fem/src/frequency_domain/modal_eigen_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2134) | [`solve_modal_eigen_contract`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/src/frequency_domain/modal_eigen_solver.cpp#L2134) | Native modal diagnostics and status. |
| [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L648) | [`evaluate_poisson_airbox_modal_residuals`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L648) | Evaluates coupled magnetic and Poisson block residuals. |
| [`backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L658) | [`apply_poisson_airbox_modal_residual_certification`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.hpp#L658) | Enforces coupled residual acceptance criteria. |
| [`backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L98) | [`certify_floquet_realified_mode`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/include/frequency_domain/floquet_dynamic_demag_k.hpp#L98) | Certifies complex Floquet modes reconstructed from real-split pencils. |
| [`backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp#L500) | [`floquet_shifted_true_convergence_test`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/backends/fem/cpu/frequency_domain/modal/shifted_ksp_true_convergence.hpp#L500) | Enforces true unpreconditioned KSP residual convergence. |

## Cross-links

* {doc}`index`
* {doc}`linearized-llg`
* {doc}`/python-api/studies/eigenmodes`
* {doc}`/python-api/outputs/modes-and-spectra`
* {doc}`/python-api/outputs/dispersion-and-response`
* {doc}`/frontend/capability-register`
