---
title: Projected Gradient
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: /physics/foundations/micromagnetic-energy, /physics/foundations/effective-field
---

(public-docs-numerical-methods-relaxation-projected-gradient)=
# Projected gradient with Barzilai–Borwein steps

(numerical-methods-relaxation-pgbb-problem-statement)=
## Scope and purpose

This page documents the projected-gradient direct minimizer with Barzilai–Borwein step selection
(`projected_gradient_bb`) for unit-norm magnetization on $(\mathbb{S}^2)^N$. It covers the tangent
gradient, normalized retraction, tangent-transported secant BB1/BB2 step selection, Armijo
backtracking with representable-chord / direct-energy bounds, device-resident single-layer CUDA
execution (`native_cuda_pgbb`), bounded FP64 `three_d` multilayer FDM support, and qualified FEM
GPU exchange-mass preconditioning (`bb_exchange_mass`).

(numerical-methods-relaxation-pgbb-governing-equations)=
## Scientific and numerical model

`projected_gradient_bb` minimizes the discrete micromagnetic energy on the product manifold
$(\mathbb{S}^2)^N$ without a physical time coordinate, LLG integrator, or damping override. Every
trial magnetization is retracted onto the unit sphere, and an Armijo line search accepts only a
sufficient energy decrease.

### Governing equations

The effective-field tangent gradient and torque residual at active cell or node $i$ are

```{math}
:label: eq-pgbb-tangent-gradient
\mathbf g_i=-\left[\mathbf H_{\mathrm{eff},i}
-\left(\mathbf m_i\cdot\mathbf H_{\mathrm{eff},i}\right)\mathbf m_i\right],
\qquad
\boldsymbol\tau_i=\mathbf m_i\times\mathbf H_{\mathrm{eff},i}.
```

The normalized sphere retraction along a tangent search direction $\mathbf p_i$ (unpreconditioned
$\mathbf p_i = -\mathbf g_i$, or exchange-mass preconditioned on FEM GPU) is

```{math}
:label: eq-pgbb-retraction
\mathcal R_{\mathbf m_i}(\lambda\mathbf p_i)
=\frac{\mathbf m_i+\lambda\mathbf p_i}
{\lVert\mathbf m_i+\lambda\mathbf p_i\rVert_2}.
```

After an accepted step from $\mathbf m_{k-1}$ to $\mathbf m_k$, the raw magnetization and gradient
differences are transported into the accepted tangent plane $T_{\mathbf m_k}\mathbb{S}^2$ via the
orthogonal projector $P_{\mathbf m_k} = I - \mathbf m_k\mathbf m_k^{\mathsf T}$ so that
$\mathbf s_k = P_{\mathbf m_k}(\mathbf m_k - \mathbf m_{k-1})$ and
$\mathbf y_k = \mathbf g_k - P_{\mathbf m_k}\mathbf g_{k-1}$. The implementation alternates BB1 and
BB2 step selection using the energy metric $\langle\cdot,\cdot\rangle_E$:

```{math}
:label: eq-pgbb-step-selection
\lambda_{k}^{\mathrm{BB1}}
=\frac{\langle\mathbf s_k,\mathbf s_k\rangle_E}
{\langle\mathbf s_k,\mathbf y_k\rangle_E},
\qquad
\lambda_{k}^{\mathrm{BB2}}
=\frac{\langle\mathbf s_k,\mathbf y_k\rangle_E}
{\langle\mathbf y_k,\mathbf y_k\rangle_E}.
```

The Armijo sufficient-decrease acceptance condition is

```{math}
:label: eq-pgbb-armijo
E(\mathbf m_{k+1})
\leq E(\mathbf m_k)+c_1\lambda_kD_k,
\qquad D_k<0,
\qquad c_1=10^{-4}.
```

The energy metric used by the FDM/shared policy is

```{math}
:label: eq-pgbb-energy-metric
\langle a,b\rangle_E
=\sum_i \mu_0 M_{s,i}V_i\,a_i\cdot b_i,
\qquad
[\langle a,b\rangle_E]
=\mathrm{J\,A^{-1}}[a][b].
```

The weight $\mu_0M_{s,i}V_i$ has units $\mathrm{J\,A^{-1}}$. Therefore $\langle g,p\rangle_E$ has
units $\mathrm{J\,A\,m^{-1}}$ when both operands are fields in $\mathrm{A\,m^{-1}}$, while
$\langle s,s\rangle_E$ has units $\mathrm{J\,A^{-1}}$ because $s$ is dimensionless. Accordingly
$\lambda$ carries units $\mathrm{m\,A^{-1}}$ and $\lambda D_k$ is an energy in $\mathrm{J}$. For
FEM, $V_i$ is replaced by the backend's assembled mass/lumped-mass realization.

**Step-selection and line-search policy**:
- Initial step: $\lambda_0 = 10^{-6}\ \mathrm{m\,A^{-1}}$.
- Alternating BB1/BB2: after an accepted step, `use_bb1=true` computes BB1 when
  $\langle \mathbf s_k, \mathbf y_k\rangle_E$ is finite and positive, then toggles to BB2 on the next
  accepted update (`use_bb1=false` computes BB2 when both $\langle \mathbf s_k, \mathbf y_k\rangle_E$
  and $\langle \mathbf y_k, \mathbf y_k\rangle_E$ are finite and positive).
- Bounds and fallback: every accepted BB value is clamped to $[10^{-15}, 10^{-3}]\ \mathrm{m\,A^{-1}}$.
  If curvature is non-positive or non-finite, the fallback is $10^{-6}/(r+1)$ clamped to the same
  interval, where $r$ is the consecutive fallback count.
- Backtracking and representable-chord Armijo: each rejected trial halves $\lambda$ (up to 20
  backtracks), leaving the accepted state unchanged on exhaustion. Armijo evaluation accounts for
  the actual retracted chord displacement and (on native FEM) direct-energy difference roundoff
  bounds.
- **FEM GPU exchange-mass preconditioning (`bb_exchange_mass`)**: When exchange is active on FEM
  GPU and `study.fem_bb_preconditioner(...)` is `"auto"` (the qualified default) or
  `"exchange_mass"`, the steepest-descent direction is replaced by the device-resident PCG solution
  of $(M_\perp + \alpha_k K_{\mathrm{ex},\perp})\mathbf p_k = -M_\perp \mathbf g_k$ projected onto
  the tangent plane (`gpu_bb_exchange_mass_solve_and_project`), eliminating the $\mathcal{O}(h^{-2})$
  exchange-stiffness slowdown while preserving Armijo monotonicity and accepted-endpoint demag
  potential reuse. See {ref}`numerical-methods-performance-fem-gpu-kernels`.

(numerical-methods-relaxation-pgbb-iteration)=
### One projected-gradient iteration

1. Evaluate $\mathbf H_{\mathrm{eff}}(\mathbf m_k)$, the tangent gradient $\mathbf g_k$, the
   current energy, and the maximum accepted-state torque. A torque threshold hit can terminate
   before an accepted minimizer step is attempted (subject to the 3-sample confirmation and optional
   energy window).
2. Form the tangent descent direction $\mathbf p_k$ ($-\mathbf g_k$ or exchange-mass preconditioned
   on FEM GPU) and directional slope $D_k = \langle\mathbf g_k, \mathbf p_k\rangle_E < 0$. A
   non-finite or non-negative product is a numerical error; an exactly zero gradient is classified
   as numerical stagnation.
3. Retract $\mathcal R_{\mathbf m}(\lambda\mathbf p_k)$ and evaluate its full energy. Accept only
   when the Armijo inequality holds. Rejected trials halve $\lambda$; after 20 rejections the
   accepted state and its field remain unchanged.
4. On acceptance, evaluate the trial field and gradient (reusing the accepted endpoint demag
   potential on FEM GPU), transport $\mathbf s_k$ and $\mathbf y_k$ into $T_{\mathbf m_k}\mathbb S^2$,
   update alternating BB1/BB2, commit the trial state, and increment `accepted_step`.
5. Record accepted energy and torque in the shared completion controller. A successful Armijo step
   is not itself convergence.

(numerical-methods-relaxation-pgbb-symbols-and-si-units)=
### Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| $\mathbf m_i$ | reduced magnetization at active cell/node $i$ | $1$ |
| $\mathbf H_{\mathrm{eff},i}$ | effective magnetic field | $\mathrm{A\,m^{-1}}$ |
| $\mathbf g_i$ | tangent-space energy gradient | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol\tau_i$ | torque residual | $\mathrm{A\,m^{-1}}$ |
| $E$ | total micromagnetic energy | $\mathrm{J}$ |
| $\mathbf s_k$ | tangent-transported magnetization difference | $1$ |
| $\mathbf y_k$ | tangent-transported gradient difference | $\mathrm{A\,m^{-1}}$ |
| $\mathbf p_i$ | tangent search direction | $\mathrm{A\,m^{-1}}$ |
| $\lambda_k$ | minimizer step size | $\mathrm{m\,A^{-1}}$ |
| $\mathcal R_{\mathbf m_i}$ | sphere retraction | $1$ |
| $D_k$ | energy directional derivative with respect to $\lambda$ | $\mathrm{J\,A\,m^{-1}}$ |
| $c_1$ | Armijo sufficient-decrease constant | $1$ |
| $N$ | number of active cells or finite-element nodes | $1$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $M_{s,i}$ | local saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $V_i$ | cell or nodal volume weight | $\mathrm{m^3}$ |
| $a_i$ | first vector in the energy metric | $\mathrm{A\,m^{-1}}$ |
| $b_i$ | second vector in the energy metric | $\mathrm{A\,m^{-1}}$ |

(numerical-methods-relaxation-pgbb-assumptions-and-validity)=
### Assumptions and validity

- Any finite non-unit initial magnetization is normalized onto $\mathbb S^2$ before the first field
  evaluation (including on `native_cuda_pgbb`).
- The normalization retraction is first-order; it is not a Cayley rotation and does not establish
  a global error bound by itself.
- BB curvature denominators are guarded. Invalid or non-positive curvature falls back to a bounded
  step rather than accepting an invalid curvature estimate.
- Armijo backtracking is the acceptance contract: a rejected trial leaves the accepted state
  unchanged.
- The stopping torque is evaluated on the accepted effective field; trial-field diagnostics never
  replace the accepted-state residual.
- `solver`, `dt`, `max_err`, `dt_min`, `dt_max`, `dt_initial`, `adaptive_timestep`,
  `field_refresh`, `max_relaxation_time_s`, and `relax_alpha` are invalid for this algorithm and
  fail validation.

(numerical-methods-relaxation-pgbb-discrete-realization)=
### Discrete realization

| Solver | Device | Status | Realization and evidence boundary |
|---|---|---|---|
| FDM | CPU | `implemented` | Reference cellwise tangent projection, transported secants, normalized retraction, and energy-metric Armijo loop (`execute_projected_gradient_bb`); supports single-layer and bounded FP64 `three_d` multilayer contracts. |
| FDM | GPU | `implemented` | Single-layer device-resident CUDA kernel pipeline (`single_layer_bb.cu`, `native_cuda_pgbb` provenance, zero hot-loop H2D/D2H, `5.84×–9.65×` wall / `~11×` stage speedup on RTX 4080 SUPER, `rel dE_total = 5.62e-11`, strict-mode receipt verified) plus bounded FP64 `three_d` multilayer PG-BB (including XY-periodic CUDA with device-resident BB reductions). |
| FEM | CPU | `implemented` | MFEM nodal tangent gradient, mass/lumped-mass products, and native Armijo loop with direct-energy difference proof (`run_projected_gradient_bb_step`). |
| FEM | GPU | `implemented` | Device-resident CUDA PGBB (`gpu_relax_projected_gradient_bb_step`) with qualified `auto` -> `bb_exchange_mass` preconditioning (`6.18×–10.52×` fewer steps, `2.82×–6.11×` faster, `-2..-3` host syncs/step, relative energy parity $\lvert\Delta E\rvert/\lvert E\rvert = 2.0\times 10^{-14}\text{–}9.0\times 10^{-12}$ vs CPU PGBB, `0` monotonicity violations) and accepted-endpoint demag potential reuse. |

FDM uses cell volumes and Cartesian fields; FEM uses finite-element node values and the selected
mass metric. Multilayer FDM `projected_gradient_bb` requires `three_d` FP64 coupled demag, equal
native/convolution cell sizes, identity or centered aligned native grids, uniform $M_s$ per object,
and no frozen spins (`crates/fullmag-plan/src/fdm.rs`). For full benchmark details, see
{ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fem-gpu-kernels`.

(numerical-methods-relaxation-pgbb-implementation-mapping)=
### Implementation mapping

The Python objects and stage lowering are shared. Single-layer FDM GPU executes entirely on device
via `context_single_layer_bb` (`native_cuda_pgbb`), while FDM CPU runs `execute_projected_gradient_bb`.
Native FEM CPU (`run_projected_gradient_bb_step`) and FEM GPU (`gpu_relax_projected_gradient_bb_step`
plus `gpu_bb_exchange_mass_solve_and_project`) own separate operator, preconditioner, and residency
state.

(numerical-methods-relaxation-pgbb-problem-ir)=
## Parameters

The executable controls are the `projected_gradient_bb` algorithm identifier, torque and optional
energy stop criteria, accepted-step budget, and (for FEM GPU) the optional
`study.fem_bb_preconditioner(...)` policy. LLG dynamics, timestep, and damping controls are
rejected for this direct minimizer.

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `StudyStagesBuilder.add_relax(algorithm="projected_gradient_bb")` | `str` | required for this page | $1$ | supported algorithm identifier | selects BB projected minimizer | FDM CPU/GPU; FEM CPU/GPU | `study.algorithm` |
| `StudyStagesBuilder.add_relax(tolT=...)` | `float` | $10^{-6}$ | $\mathrm{T}$ | finite and positive; exclusive with `tolA` | requested torque threshold | FDM/FEM lanes | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(tolA=...)` | `float` | canonical default equivalent | $\mathrm{A\,m^{-1}}$ | finite and positive; exclusive with `tolT` | field-residual threshold | FDM/FEM lanes | `study.stop.torque_tolerance_apm` |
| `StudyStagesBuilder.add_relax(max_steps=...)` | `int` | $50{,}000$ | $1$ | positive integer | iteration budget | FDM/FEM lanes | `study.stop.max_steps` |
| `StudyStagesBuilder.add_relax(energy_tolerance=...)` | `float \| None` | `None` | $\mathrm{J}$ | positive when set | accepted-energy plateau threshold | FDM/FEM lanes | `study.stop.energy_tolerance_j` |
| `StudyStagesBuilder.add_relax(stop=...)` | `RelaxStop \| None` | `None` | $1$ | grouped stop; scalar conflicts rejected | canonical stop object | FDM/FEM lanes | `study.stop` |
| `StudyBuilder.fem_bb_preconditioner(policy)` | `str` | `"auto"` | $1$ | `"auto"`, `"none"`, or `"exchange_mass"`; requires explicit FEM GPU `projected_gradient_bb` | GPU BB direction preconditioner (`"auto"` resolves to `"exchange_mass"` when exchange is active) | FEM GPU only | `discretization.fem.gpu_bb_preconditioner` |
| `StudyStagesBuilder.add_relax(tol=...)` | legacy object | unavailable | $1$ | always rejected | removed tolerance spelling | none | none |
| LLG-only keywords (`solver`, `dt`, `max_err`, `max_error`, `dt_min`, `dt_max`, `dt_initial`, `adaptive_timestep`, `field_refresh`, `relax_alpha`, `max_relaxation_time_s`, `max_pseudotime_s`, `max_physical_time_s`) | various | `None` | $1$ | rejected for direct minimizers | LLG dynamics and time controls | none | none |

No public parameter controls $c_1$, the BB step bounds, or the maximum number of Armijo backtracks;
those are implementation policy constants recorded in provenance.

(numerical-methods-relaxation-pgbb-python-api)=
## Python API

```python
# %% Configure a FEM projected-gradient BB relaxation stage
import fullmag as fm

nm = 1.0e-9
study = fm.study("projected_gradient_bb_relaxation")
study.engine("fem")
study.device("gpu", precision="double")
study.mode("strict")
study.fem_bb_preconditioner("auto")
study.universe(mode="manual", size=(700 * nm, 250 * nm, 250 * nm))

film = study.geometry(
    fm.Box(size=(500 * nm, 125 * nm, 3 * nm), name="film"),
    name="film",
)
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.1, 0.0)
study.exchange()
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    tolT=1.0e-6,
    max_steps=50_000,
)
```

### `ProblemIR` excerpt

The stage lowers to a relaxation study without a `dynamics` object:

```json
{
  "kind": "relaxation",
  "algorithm": "projected_gradient_bb",
  "stop": {
    "torque_tolerance_apm": 0.7957747154594767,
    "max_steps": 50000
  }
}
```

The absence of `dynamics` is semantic: a direct minimizer has no RK solver or physical time. The
resolved runtime publishes `energy_minimizer_realization` (e.g., `native_cuda_pgbb`),
`accepted_step_m_per_A`, `time=0`, `dt=0`, `pseudo_time_s=null`, torque in $\mathrm{A\,m^{-1}}$ and
$\mathrm{T}$, FEM BB preconditioner resolution (`auto -> exchange_mass`), and final energy/plateau
metrics.

## Control Room workflow

Use the stage editor to select `projected_gradient_bb` and configure direct-minimizer stop controls.
Inspect resolved algorithm, lane, preconditioner policy, and completion telemetry; LLG integrator
and physical-time fields are not authorable controls for this stage.

(numerical-methods-relaxation-pgbb-round-trip-and-failure-semantics)=
## Diagnostics and failure semantics

- **Round-trip preservation**: Script export preserves `algorithm="projected_gradient_bb"`, stop
  fields in `study.stages.add_relax(...)`, and any explicit `study.fem_bb_preconditioner(...)`,
  recording requested intent separately from resolved execution provenance.
- **Validation errors**: Unknown algorithm, non-positive thresholds, non-positive `max_steps`,
  legacy `tol`, simultaneous `tolT` and `tolA`, any LLG timestep/dynamics control, or setting
  `fem_bb_preconditioner` outside an explicit FEM GPU `projected_gradient_bb` stage raise immediate
  errors.
- **Fail-closed semantics**: Unsupported combinations (such as multilayer FDM with frozen spins or
  non-uniform per-object $M_s$, or requesting FEM GPU without executable capability) fail closed
  with zero silent fallback to CPU or `llg_overdamped`.
- **Runtime diagnostics**: Record tangent orthogonality, BB curvature guards, Armijo trials and
  rollback, host-device sync counts, strict residency receipt (`hot_loop_full_vector_h2d/d2h = 0`
  on `native_cuda_pgbb`), accepted energy, and accepted-state torque completion.

(numerical-methods-relaxation-pgbb-validation)=
## Validation

- **FDM GPU RTX 4080 SUPER A/B**: `native_cuda_pgbb` achieves `5.84×–9.65×` wall (`~11×` stage)
  speedup with `hot_loop_full_vector_h2d = 0`, `hot_loop_full_vector_d2h = 0`, `fallback_count = 0`,
  and `rel dE_total = 5.62e-11` vs baseline.
- **FEM GPU RTX 4080 SUPER A/B**: `bb_exchange_mass` (`auto -> exchange_mass`) matches CPU PGBB
  step counts exactly (`39 == 39` at $h=3\;\mathrm{nm}$, `29 == 29` at $h=2\;\mathrm{nm}$,
  `53 == 53` on slab), reduces steps `6.18×–10.52×`, accelerates wall time `2.82×–3.79×` (`cuDSS`)
  and `6.11×` (`CG+AMG`), cuts host syncs by `2.0–3.0/step`, and agrees with CPU PGBB to
  `ΔE/|E| = 2.0e-14..9.0e-12` with `0` monotonicity violations (`compute-sanitizer` 0 errors). See
  {doc}`../../validation/cpu-gpu-parity`.

(numerical-methods-relaxation-pgbb-limitations)=
## Limitations

The method is a local minimizer and may terminate at a metastable state. It does not promise a fixed
iteration count, identical trajectories across discretizations, or universal 4-lane qualification
outside the verified contracts ({doc}`../../validation/qualification-status`). It has no
physical-time interpretation.

(numerical-methods-relaxation-pgbb-scientific-bibliography)=
## Scientific bibliography

- J. Barzilai and J. M. Borwein, “Two-point step size gradient methods,” *IMA Journal of Numerical Analysis* **8**, 141–148 (1988), DOI: [10.1093/imanum/8.1.141](https://doi.org/10.1093/imanum/8.1.141).
- J. Nocedal and S. J. Wright, *Numerical Optimization*, 2nd ed., Springer, 2006, DOI: [10.1007/978-0-387-40065-5](https://doi.org/10.1007/978-0-387-40065-5).
- FullMag public physics contracts: {doc}`/physics/foundations/micromagnetic-energy` and {doc}`/physics/foundations/effective-field`.

(numerical-methods-relaxation-pgbb-source-code-index)=
## Where this is implemented

| Claim | Repository path | Stable symbol | Responsibility | Lane | Evidence |
|---|---|---|---|---|---|
| Public algorithm vocabulary | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L901) | [`class Relaxation`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L901) | validates direct-minimizer selection and forbids dynamics | public API | Python contract tests |
| Stage lowering | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3419) | [`relax_stage`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3419) | captures direct-minimizer stage | public API | stage export tests |
| FEM GPU BB policy carrier | [`packages/fullmag-py/src/fullmag/model/bb_pipeline.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/bb_pipeline.py#L5) | [`is_gpu_bb_only_pipeline`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/bb_pipeline.py#L5) | validates explicit FEM GPU `projected_gradient_bb` pipeline for `fem_bb_preconditioner` | public API | `test_fem_gpu_bb_preconditioner.py` |
| FDM BB loop | [`crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs#L510) | [`execute_projected_gradient_bb`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer_reference.rs#L510) | reference cellwise BB/Armijo implementation | FDM CPU/reference | Rust unit tests |
| FDM GPU device-resident BB | [`backends/fdm/gpu/cuda/runtime/single_layer_bb.cu`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/single_layer_bb.cu#L1064) | [`context_single_layer_bb`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fdm/gpu/cuda/runtime/single_layer_bb.cu#L1064) | single-layer device-resident CUDA PG-BB (`native_cuda_pgbb`) | FDM GPU | RTX 4080 SUPER A/B verified |
| FDM CUDA dispatch | [`crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs#L729) | [`execute_direct_minimizer`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fdm/gpu/cuda/direct_minimizer.rs#L729) | native CUDA PG/NCG dispatch and residency receipt | FDM GPU | device-gated tests |
| FEM CPU BB loop | [`backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp#L130) | [`run_projected_gradient_bb_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/cpu/mfem/relaxation/projected_gradient_bb.cpp#L130) | native FEM tangent/Armijo step | FEM CPU | native contract tests |
| FEM GPU BB loop | [`backends/fem/gpu/cuda/relaxation/pgbb.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/relaxation/pgbb.cpp#L707) | [`gpu_relax_projected_gradient_bb_step`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/relaxation/pgbb.cpp#L707) | device-resident FEM BB step with endpoint potential reuse | FEM GPU | RTX 4080 SUPER A/B verified |
| FEM GPU exchange-mass preconditioner | [`backends/fem/gpu/cuda/relaxation/bb_exchange_mass.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/relaxation/bb_exchange_mass.cpp#L295) | [`gpu_bb_exchange_mass_solve_and_project`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/gpu/cuda/relaxation/bb_exchange_mass.cpp#L295) | solves $(M_\perp+\alpha_k K_{\mathrm{ex},\perp})p_k=-M_\perp g_k$ on GPU | FEM GPU | `fem_cuda_bb_exchange_mass_contract` + memcheck |
| Shared metric and BB policy | [`crates/fullmag-runner/src/relaxation/direct_minimizer.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer.rs#L630) | [`energy_metric_dot`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer.rs#L152) / [`projected_gradient_step_size_update`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer.rs#L630) | weighted products, transported secants, bounds and fallback | FDM CPU/GPU shared policy | Rust unit tests |
| Shared line search | [`crates/fullmag-runner/src/relaxation/direct_minimizer.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer.rs#L424) | [`projected_gradient_line_search`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/direct_minimizer.rs#L424) | normalized trial, Armijo and 20-backtrack limit | FDM CPU/GPU shared policy | Rust unit tests |
| Minimizer provenance | [`crates/fullmag-runner/src/relaxation/provenance.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/provenance.rs#L112) | [`resolve_fem_direct_minimizer_policy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/provenance.rs#L112) | records `native_cuda_pgbb` and FEM BB preconditioner resolution | shared provenance | runner provenance tests |
| Completion policy | [`crates/fullmag-runner/src/relaxation/convergence.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L235) | [`resolve_stage_completion`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/relaxation/convergence.rs#L235) | torque confirmation, energy plateau and budget reasons | shared orchestration | runner tests |
