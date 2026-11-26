---
title: Frequency Response
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

(public-docs-python-api-studies-frequency-response)=
# Frequency Response

(python-api-studies-frequency-response-problem-statement)=
## 1. Physical problem and solver family

`fm.FrequencyResponse` and `study.stages.add_frequency_response(...)` define the public Python authoring contract for first-order harmonic steady-state response studies around an accepted equilibrium $\mathbf{m}_0(\mathbf{r})$ at prescribed drive frequencies $\{f_j\}$.

Solver mathematics, Schur-complement elimination, factor-once GPU `cuDSS` direct solves (`method="gpu_sparse_direct"`), and algebraic residual qualification are documented in {doc}`../../numerical-methods/frequency-domain/index`, {doc}`../../numerical-methods/frequency-domain/response-solver`, and {ref}`numerical-methods-performance-fem-spectral-multiphysics`.

(python-api-studies-frequency-response-governing-equations)=
## 2. Governing equations

For a small harmonic excitation field $\delta\mathbf{h}_{\mathrm{ext}}(\mathbf{r}, t) = \Re\{\widehat{\mathbf{h}}_{\mathrm{ext}}(\mathbf{r})\,\mathrm{e}^{\mathrm{i}\omega t}\}$ at angular frequency $\omega = 2\pi f$, the linearized tangent-plane response $\widehat{\mathbf{q}}(\omega)$ satisfies the forced linear system:

```{math}
:label: eq-studies-frequency-response-system

\mathsf{A}(\omega)\,\widehat{\mathbf{q}}(\omega) = \widehat{\mathbf{b}}(\omega), \qquad \mathsf{A}(\omega) = \mathsf{K} + \mathrm{i}\omega\mathsf{G}, \qquad \widehat{\mathbf{b}}(\omega) = \mathsf{C}\,\widehat{\mathbf{h}}_{\mathrm{ext}}\,\mathrm{e}^{\mathrm{i}\phi_{\mathrm{drive}}}
```

(python-api-studies-frequency-response-symbols-and-si-units)=
## 3. Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $f$ | prescribed harmonic drive frequency (`frequencies_hz`) | $\mathrm{Hz}$ |
| $\omega$ | angular drive frequency $2\pi f$ | $\mathrm{rad\,s^{-1}}$ |
| $\widehat{\mathbf{h}}_{\mathrm{ext}}$ | transverse excitation field amplitude (`excitation_field_au_per_m`) | $\mathrm{A\,m^{-1}}$ |
| $\phi_{\mathrm{drive}}$ | global harmonic drive phase (`excitation_phase_rad`) | $\mathrm{rad}$ |
| $\mathsf{A}(\omega)$ | shifted complex tangent response operator | $\mathrm{rad\,s^{-1}}$ |
| $\mathsf{K}$ | linearized effective-field stiffness operator | $\mathrm{rad\,s^{-1}}$ |
| $\mathsf{G}$ | gyrotropic and Gilbert damping operator | $1$ |
| $\mathsf{C}$ | tangent-plane drive projection operator | $\mathrm{m\,A^{-1}\,s^{-1}}$ |
| $\widehat{\mathbf{q}}(\omega)$ | complex tangent-coordinate response vector | $1$ |
| $\widehat{\mathbf{b}}(\omega)$ | assembled harmonic right-hand side vector | $\mathrm{rad\,s^{-1}}$ |

(python-api-studies-frequency-response-assumptions-and-validity)=
## 4. Assumptions, boundary meaning, and validity limits

| Choice | Mathematical meaning | What it does not mean |
| --- | --- | --- |
| `frequencies_hz=[1e9, 2e9, ...]` | Solves the independent linear system $\mathsf{A}(2\pi f_j)\widehat{\mathbf{q}} = \widehat{\mathbf{b}}$ at each positive frequency $f_j > 0$. | Does not run a time-domain transient simulation or nonlinear harmonic-balance expansion. |
| `equilibrium_source="relax"` | Relaxes the initial state to an accepted equilibrium $\mathbf{m}_0$ before linearizing the operator. | Does not linearize around an unrelaxed transient state unless `equilibrium_source="provided"` is explicitly chosen. |
| `solver_policy=FrequencyResponseSolverPolicy(...)` | Supplies requested solver method (`auto`, `gpu_sparse_direct`, `gpu_operator_host_krylov`, `schur_reduced`, `dense_reference`, etc.), preconditioner, relative tolerance, and Krylov iteration limits. | Does not bypass planner capability checks, VRAM preflight, or true-residual verification. |

(python-api-studies-frequency-response-python-api)=
## 5. Python API and complete parameter reference

### Stage-first example: FEM driven susceptibility sweep

```python
# %% Stage-first FEM driven susceptibility sweep
import fullmag as fm

nm = 1.0e-9
study = fm.study("frequency_response_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(300 * nm, 120 * nm, 100 * nm))
study.objects.mesh.defaults(maximum_element_size=5 * nm)

# %%
film = study.geometry(fm.Box(size=(100 * nm, 20 * nm, 5 * nm)), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag(model="airbox", variant="robin")

# %%
study.stages.add_relax(stage_id="relax_eq", dt=5.0e-13, max_steps=100)
study.stages.add_frequency_response(
    frequencies_hz=[5.0e9, 7.5e9, 10.0e9],
    excitation_field_au_per_m=(0.0, 100.0, 0.0),
    excitation_phase_rad=0.0,
    observable="susceptibility_tensor",
    include_demag=True,
    equilibrium_source="relax",
    damping_policy="include",
    magnetostatic_bc="open",
    solver_method="auto",
    solver_preconditioner="block_jacobi",
    solver_rtol=1.0e-8,
    solver_max_iterations=500,
    solver_restart_iterations=50,
)
```

### Parameter reference (`FrequencyResponse` and `FrequencyResponseSolverPolicy`)

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `FrequencyResponse.outputs` | `Sequence[FrequencyOutputSpec]` | `required` | $1$ | At least one | Response observables | FEM CPU/GPU; planner checks materialization | `sampling.outputs` |
| `FrequencyResponse.frequencies_hz` | `Sequence[float]` | `required` | $\mathrm{Hz}$ | Non-empty, finite, positive | Sweep frequencies | FEM CPU/GPU | `frequencies_hz.values_hz` |
| `FrequencyResponse.excitation_field_au_per_m` | `tuple[float, float, float]` | `(0.0, 0.0, 1.0)` | $\mathrm{A\,m^{-1}}$ | Length-3 finite vector | Small transverse excitation field | FEM CPU/GPU | `excitation.field_au_per_m` |
| `FrequencyResponse.excitation_phase_rad` | `float` | `0.0` | $\mathrm{rad}$ | Finite | Excitation phase | FEM CPU/GPU | `excitation.phase_rad` |
| `FrequencyResponse.operator` | `str` | `"linearized_llg"` | $1$ | `linearized_llg` or `full_2x2` | Linearized operator | FEM CPU/GPU | `operator.kind` |
| `FrequencyResponse.equilibrium_source` | `str` | `"provided"` | $1$ | `provided`, `relax`, or `artifact` | Equilibrium acquisition | FEM CPU/GPU | `equilibrium` |
| `FrequencyResponse.equilibrium_artifact` | `str \| None` | `None` | $1$ | Non-empty path/reference required when `equilibrium_source="artifact"` | Equilibrium checkpoint/artifact path | FEM CPU/GPU | `equilibrium.artifact` |
| `FrequencyResponse.include_demag` | `bool` | `True` | $1$ | Boolean | Include dynamic demagnetization | FEM CPU/GPU | `operator.include_demag` |
| `FrequencyResponse.k_sampling` | `object \| None` | `None` | $\mathrm{rad\,m^{-1}}$ | Valid wave-vector sampling (`KPoint`, `KPath`, or mapping) | Wave-vector sampling for periodic/Bloch response | FEM CPU/GPU | `k_sampling` |
| `FrequencyResponse.k_vector` | `tuple[float, float, float] \| None` | `None` | $\mathrm{rad\,m^{-1}}$ | Length-3 finite wave vector | Single Bloch wave vector | FEM CPU/GPU | `k_sampling` |
| `FrequencyResponse.normalization` | `str` | `"unit_l2"` | $1$ | `unit_l2` or `unit_max_amplitude` | Response vector normalization convention | FEM CPU/GPU | `normalization` |
| `FrequencyResponse.damping_policy` | `str` | `"ignore"` | $1$ | `ignore` or `include` | Damping treatment in the linearized operator | FEM CPU/GPU | `damping_policy` |
| `FrequencyResponse.spin_wave_bc` | `str \| mapping \| PeriodicBC \| FloquetBC` | `"free"` | $1$ | `free`, `pinned`, `periodic`, `floquet`, `surface_anisotropy` | Spin-wave boundary condition | FEM CPU/GPU | `spin_wave_bc` |
| `FrequencyResponse.magnetostatic_bc` | `str` | `"open"` | $1$ | `open`, `periodic_airbox_k0`, or `floquet_airbox` | Magnetostatic boundary condition | FEM CPU/GPU | `magnetostatic_bc` |
| `FrequencyResponse.solver_policy` | `FrequencyResponseSolverPolicy \| None` | `None` | mixed | Valid method/preconditioner/tolerance/iteration values | Solver method and preconditioner overrides | FEM CPU/GPU | `solver_policy` |
| `FrequencyResponse.dynamics` | `LLG` | `LLG()` | mixed | Typed `LLG` dynamics contract | Gyromagnetic ratio and reference dynamics contract | FEM CPU/GPU | `dynamics` |
| `FrequencyResponseSolverPolicy.method` | `str \| None` | `None` | $1$ | One of `auto`, `dense_reference`, `schur_reduced`, `cpu_sparse_direct`, `gpu_sparse_direct`, `full_coupled_field_split`, `modal_reduced`, `gpu_operator_host_krylov`, `gpu_device_krylov` | Requested linear solver lane (`gpu_sparse_direct` selects factor-once GPU `cuDSS`) | FEM CPU/GPU | `solver_policy.method` |
| `FrequencyResponseSolverPolicy.preconditioner` | `str \| None` | `None` | $1$ | One of `auto`, `graph_demag_coarse`, `demag_coarse`, `block_jacobi`, `none` | Requested Krylov preconditioner | FEM CPU/GPU | `solver_policy.preconditioner` |
| `FrequencyResponseSolverPolicy.rtol` | `float \| None` | `None` | $1$ | Finite and positive | Relative algebraic residual tolerance | FEM CPU/GPU | `solver_policy.rtol` |
| `FrequencyResponseSolverPolicy.max_iterations` | `int \| None` | `None` | $1$ | Positive integer | Maximum Krylov iterations per frequency | FEM CPU/GPU | `solver_policy.max_iterations` |
| `FrequencyResponseSolverPolicy.restart_iterations` | `int \| None` | `None` | $1$ | Positive integer $\le$ `max_iterations` | GMRES/FGMRES restart subspace dimension | FEM CPU/GPU | `solver_policy.restart_iterations` |

(python-api-studies-frequency-response-problem-ir)=
## 6. ProblemIR, normalization, and provenance

`FrequencyResponse.to_ir()` emits `{"kind": "frequency_response", ...}` with `dynamics`, `operator`, `equilibrium`, `k_sampling`, `normalization`, `damping_policy`, `spin_wave_bc`, `magnetostatic_bc`, `excitation`, `frequencies_hz`, `sampling`, and optional `solver_policy`:

```json
{
  "kind": "frequency_response",
  "operator": {
    "kind": "linearized_llg",
    "include_demag": true
  },
  "equilibrium": {
    "kind": "relaxed_initial_state"
  },
  "k_sampling": null,
  "normalization": "unit_l2",
  "damping_policy": "include",
  "spin_wave_bc": "free",
  "magnetostatic_bc": "open",
  "excitation": {
    "field_au_per_m": [0.0, 100.0, 0.0],
    "phase_rad": 0.0
  },
  "frequencies_hz": {
    "values_hz": [5000000000.0, 7500000000.0, 10000000000.0]
  },
  "solver_policy": {
    "method": "gpu_sparse_direct",
    "rtol": 1e-8
  }
}
```

(python-api-studies-frequency-response-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

Requested intent is preserved in Python and `ProblemIR`; resolved execution and solver method are selected by the planner and recorded separately in runtime provenance. Validation errors reject empty sweeps, non-positive frequencies, malformed excitation vectors, invalid operator or boundary-condition values, and inconsistent solver policy (`restart_iterations > max_iterations`). Unsupported combinations and VRAM budget violations fail closed without silent fallback.

(python-api-studies-frequency-response-discrete-realization)=
## 8. Discrete realization and execution sequence

### 8.1 Planner resolution

`plan_fem_frequency_response` validates the equilibrium source, boundary constraints, magnetostatic closure, and solver policy before lowering into `FemFrequencyResponsePlanIR`.

### 8.2 Backend and device support matrix

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `implemented` | Executes `production_cpu_host_gmres`, `schur_reduced`, or `dense_reference` with true unpreconditioned residual verification. |
| FEM | GPU | `implemented` | Supports factor-once 2×2 block-prescaled Ruiz-equilibrated `gpu_sparse_direct` (`cuDSS`) and `gpu_operator_host_krylov` with VRAM preflight and unscaled residual certification; see {ref}`numerical-methods-performance-fem-spectral-multiphysics`. |
| FDM | CPU | `unsupported` | Native FDM frequency-response execution is rejected by the planner. |
| FDM | GPU | `unsupported` | Native FDM GPU frequency-response execution is rejected by the planner. |

(python-api-studies-frequency-response-implementation-mapping)=
## 9. Implementation mapping

- Stage builder and spec: `packages/fullmag-py/src/fullmag/world.py` (`class FrequencyResponseStageSpec`, `frequency_response_stage`, `add_frequency_response`).
- Study and solver policy models: `packages/fullmag-py/src/fullmag/model/study.py` (`class FrequencyResponse`, `class FrequencyResponseSolverPolicy`).
- Rust planner: `crates/fullmag-plan/src/fem.rs` (`plan_fem_frequency_response`).
- Native FEM solver: `backends/fem/src/frequency_domain/driven_response_solver.cpp` (`solve_driven_frequency_response`) and `backends/fem/gpu/frequency_domain/driven_response_cudss.cpp`.

(python-api-studies-frequency-response-validation)=
## 10. Validation and qualification

| Validation layer | Required check | Evidence required |
| --- | --- | --- |
| Python $\to$ IR serialization | `FrequencyResponse.to_ir()` & `FrequencyResponseSolverPolicy.to_ir()` | Verifies frequency list, excitation vector/phase, and solver policy (`gpu_sparse_direct`) round-trip. |
| Algebraic residual gate | True residual verification | Recomputes unscaled $\|\widehat{\mathbf{b}} - \mathsf{A}(\omega)\widehat{\mathbf{q}}\|_2$ per frequency sample. |

(python-api-studies-frequency-response-limitations)=
## 11. Limitations and failure modes

- Native FDM frequency-response execution is unsupported and rejected at the planner boundary.
- Several target solver-tree methods (`cpu_sparse_direct`, `full_coupled_field_split`, `modal_reduced`, `gpu_device_krylov`) remain gated by `frequency_response_solver_method_rejection_reason` in the current runtime.

(python-api-studies-frequency-response-scientific-bibliography)=
## 12. Scientific bibliography

- C. Kittel, *On the theory of ferromagnetic resonance absorption*, Phys. Rev. **73**, 155–161 (1948), DOI: [10.1103/PhysRev.73.155](https://doi.org/10.1103/PhysRev.73.155).
- Y. Saad and M. H. Schultz, *GMRES: A generalized minimal residual algorithm for solving nonsymmetric linear systems*, SIAM J. Sci. Stat. Comput. **7**, 856–869 (1986), DOI: [10.1137/0907058](https://doi.org/10.1137/0907058).

## Control Room support

Status: Frequency-response stage authoring, FMR susceptibility sweeps, peak extraction, and 3D driven response playback are `partial`; specialized `FrequencyResponseSolverPolicy` linear-system tuning fields without UI controls remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
| --- | --- | --- | --- |
| Driven frequency bounds, step schedule, & excitation binding | `Model Explorer -> Stages -> Add stage -> Frequency Response` (`FrequencyResponseStageSpec`, `StudyStagesSpec`) | `partial` | Submit stage draft and trigger stage compute; downstream result resources are invalidated |
| Swept FMR curve, resonance peaks, & complex susceptibility detail | `Analysis Plots` (`FmrResponseSweepInspectorPanel`, `FmrPeakInspector`, `FrequencyDomainResponseChart`) | `inspection-only` | Readback from `/v2/sessions/current/analysis/frequency-response/*` and `SolutionSet` artifacts |
| Driven spatial response field & harmonic phase playback in 3D | `3D Viewport` (`ModeVisualizationInspectorPanel`) | `inspection-only` | `analysis.frequency-response.plot-response-field-3d` and `analysis.frequency-domain.set-3d-phase` |
| Solver policy parameters without a named UI field | `Model Explorer -> Stages -> Add stage -> Frequency Response` | `Python-only` | Authored in Python |

```{image} /_static/images/ui/charts-dispersion-and-fmr-spectrum.png
:alt: Control Room FMR frequency-response curve, extracted peaks, and frequency-domain inspection view
:align: center
:width: 100%
```

```{image} /_static/images/ui/inspector-study-stages-and-rerun.png
:alt: Study and Stage Inspectors displaying frequency-response stage sequencing and re-run controls
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register`, {doc}`/frontend/inspectors/analysis-and-frequency-domain`, and {doc}`/frontend/inspectors/studies-and-stages`.
Frontend source owners: `apps/control-room/src/modules/inspector/inspectors/study/stages/FrequencyResponseStageSpec.tsx`, `apps/control-room/src/modules/inspector/inspectors/study/StudyStagesSpec.tsx`, `FmrResponseSweepInspectorPanel`, and `ModeVisualizationInspectorPanel`.

(python-api-studies-frequency-response-source-code-index)=
## 13. Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| Frequency-response study parameters and IR lowering | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L1335) | `class FrequencyResponse` | Frequency-response study parameters and IR lowering | API contract and lowering tests |
| Frequency-response solver policy validation and lowering | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/study.py#L117) | `class FrequencyResponseSolverPolicy` | Frequency-response solver policy validation and lowering | API contract and lowering tests |
| Stage specification and builder | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L3103) | `class FrequencyResponseStageSpec` | Stage-first frequency-response specification | API contract and lowering tests |
| Stage authoring entrypoint | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5122) | `add_frequency_response` | Stage-first authoring entrypoint on `StudyStagesBuilder` | API contract and lowering tests |
| Planner frequency-response lowering | [`crates/fullmag-plan/src/fem.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-plan/src/fem.rs#L7087) | `plan_fem_frequency_response` | Lowers `FrequencyResponse` IR into `FemFrequencyResponsePlanIR` | Planner contract tests |
| Native FEM driven response solver | [`backends/fem/src/frequency_domain/driven_response_solver.cpp`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/backends/fem/src/frequency_domain/driven_response_solver.cpp#L17743) | `solve_driven_frequency_response` | Executes FEM harmonic response sweep and residual verification | Native frequency-domain tests |
