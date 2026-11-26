---
title: Dispersion and Response
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: packages/fullmag-py/src/fullmag/model/outputs.py, crates/fullmag-runner/src/eigen/tracking.rs
---

(public-docs-python-api-outputs-dispersion-and-response)=
# Dispersion and Response

(python-api-outputs-dispersion-and-response-problem-statement)=
## 1. Contract and scope

This page records the dispersion-curve (`fm.SaveDispersion`) and frequency-response (`fm.SaveResponse`)
output descriptors attached to `fm.Eigenmodes` and `fm.FrequencyResponse` studies, together with
time-domain spectral response descriptors (`fm.GammaResponseAnalysis`, `fm.FiniteKResponseAnalysis`,
and `study.stages.fft_response(...)`).

(python-api-outputs-dispersion-and-response-governing-equations)=
## 2. Governing equations

Response and dispersion definitions belong to {doc}`../../numerical-methods/frequency-domain/index`
and {doc}`../../numerical-methods/eigensolvers/index`. `SaveDispersion` publishes $\omega_b(\mathbf k_s)$
and tracked branch tables (`eigen/branches.v2.json` and `eigen/dispersion.csv`), while
`SaveResponse` publishes steady-state dynamic susceptibility and complex response fields
$\delta\mathbf m(\omega)$.

(python-api-outputs-dispersion-and-response-symbols-and-si-units)=
## 3. Symbols and SI units

Eigenfrequency values are in hertz ($\mathrm{Hz}$), wave vectors in $\mathrm{rad\,m^{-1}}$, and
response observables carry the SI units of their physical definition.

(python-api-outputs-dispersion-and-response-assumptions-and-validity)=
## 4. Assumptions and validity

Response observable identifiers and dispersion names are validated immediately upon construction and
checked for stage compatibility during planning (`validate_eigen_outputs`).

(python-api-outputs-dispersion-and-response-python-api)=
## 5. Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SaveDispersion.name` | `str` | `"dispersion"` | $1$ | Non-empty | Curve name | FEM CPU/GPU; planner checks materialization | `dispersion_curve.name` |
| `SaveDispersion.include_branch_table` | `bool` | `True` | $1$ | Boolean | Include branch table | FEM CPU/GPU; planner checks materialization | `dispersion_curve.include_branch_table` |
| `SaveResponse.observable` | `str` | `required` | $1$ | One of the 9 supported response observables | Response output | FEM CPU/GPU; planner checks materialization | `frequency_response_output.observable` |

Supported response observables: `susceptibility_tensor`, `m_complex`, `u_complex`,
`strain_complex`, `stress_complex`, `absorbed_power_density`, `response_amplitude`,
`response_phase`, and `mode_hybridization_index`.

### Time-domain FFT response analysis descriptors

For broadband time-domain excitation stages, attach spectral post-processing via
`study.stages.fft_response(...)` using:

- `fm.GammaResponseAnalysis(response_component="my", weighting="Ms_times_lumped_volume", detrend="linear", window="hann", susceptibility_floor_fraction=1e-6)` — computes uniform ($\mathbf{k}=\mathbf{0}$) dynamic susceptibility from the weighted magnetization trace.
- `fm.FiniteKResponseAnalysis(response_component="my", probe_count=128, analysis_x_min_m=None, analysis_x_max_m=None)` — samples a line of spatial probes to compute $S(k, f)$ spin-wave dispersion spectra.

### Complete stage-first example

```python
# %% Frequency response with a susceptibility observable
import fullmag as fm

nm = 1.0e-9

study = fm.study("dispersion_response_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(400 * nm, 150 * nm, 100 * nm))

film = study.geometry(fm.Box(size=(100 * nm, 20 * nm, 5 * nm), name="film"), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.demag(model="airbox", variant="robin")
study.stages.add_relax(stage_id="relax", algorithm="nonlinear_cg", max_steps=1000, tolT=1e-6)
study.save_response("susceptibility_tensor")
study.stages.add_frequency_response(
    frequencies_hz=[1.0e9, 2.0e9],
    excitation_field_au_per_m=(0.0, 1.0, 0.0),
    equilibrium_source="relax",
)
```

(python-api-outputs-dispersion-and-response-problem-ir)=
## 6. ProblemIR

`SaveDispersion.to_ir()` emits `dispersion_curve`; `SaveResponse.to_ir()` emits
`frequency_response_output`. Both are carried in the study's `sampling.outputs`.

(python-api-outputs-dispersion-and-response-round-trip-and-failure-semantics)=
## 7. Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is
the planner or realization result. Validation errors identify the violated domain rule, and
unsupported combinations are rejected explicitly rather than silently substituted. Unknown response
observables fail immediately; dispersion names are preserved without interpretation.

(python-api-outputs-dispersion-and-response-discrete-realization)=
## 8. Discrete realization

Response materialization follows the frequency-domain solvers (including factor-once GPU `cuDSS`
driven response per {ref}`numerical-methods-performance-fem-spectral-multiphysics`); dispersion
follows the modal eigensolver and `track_branches` (`crates/fullmag-runner/src/eigen/tracking.rs`).

(python-api-outputs-dispersion-and-response-implementation-mapping)=
## 9. Implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `implemented` | Materializes tracked dispersion curves and harmonic response observables. |
| FEM | GPU | `implemented` | Supports GPU `cuDSS` / Krylov driven response observables and qualified GPU modal lanes. |
| FDM | CPU | `partial` | Supports time-domain `fft_response` (`GammaResponseAnalysis`, `FiniteKResponseAnalysis`); native linear eigen/frequency-response studies are FEM-only. |
| FDM | GPU | `partial` | Supports time-domain `fft_response`; native linear eigen/frequency-response studies are FEM-only. |

(python-api-outputs-dispersion-and-response-validation)=
## 10. Validation

Ownership tests compare this inventory with live signatures.

(python-api-outputs-dispersion-and-response-limitations)=
## 11. Limitations

Requesting an output does not guarantee the solver materializes it; planner and solver capability
resolution are authoritative.

(python-api-outputs-dispersion-and-response-scientific-bibliography)=
## 12. Scientific bibliography

Definitions belong to {doc}`../../numerical-methods/frequency-domain/index` and
{doc}`../../numerical-methods/eigensolvers/index`.

## Control Room support

Status: Spectral dispersion and driven response inspection are `implemented` as `inspection-only` result views, while stage output selectors (`Outputs`) are `partial` and unsupported raw output serialization formats remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
| --- | --- | --- | --- |
| Dispersion & response output specs (`SaveDispersion`, `SaveResponse`) | `Model Explorer -> Stages -> <stage> -> Outputs` (`StudyStagesSpec`) | `partial` | Submit stage draft; output resources are revised after execution |
| Dispersion curves, tracked branches, & $S(k,f)$ heatmaps | `Analysis Plots` (`EigenDispersionInspectorPanel`, `DynamicStructureFactorView`, `SpinWaveGammaView`) | `inspection-only` | Readback from `/v2/sessions/current/analysis/spin-wave/*` and `SolutionSet` (decimated heatmaps disclose bounding explicitly) |
| Driven FMR curves & resonance peak tables | `Analysis Plots` (`FmrResponseSweepInspectorPanel`, `FmrPeakInspector`, `FrequencyResponseChart`) | `inspection-only` | Readback from `/v2/sessions/current/analysis/frequency-response/*` and interactive peak selection |
| Saved multi-run dispersion / spectrum comparison | `Results Navigator` (`SavedResultsBrowser`) | `inspection-only` | Offline comparison across materialized `SolutionSet` revisions |
| Output formatting flags without a named UI field | `Model Explorer -> Stages -> <stage> -> Outputs` | `Python-only` | Authored in Python |

```{image} /_static/images/ui/charts-dispersion-and-fmr-spectrum.png
:alt: Spin-wave dispersion, Dynamic Structure Factor S(k,f) heatmap, and FMR spectrum inside Control Room Analysis Plots
:align: center
:width: 100%
```

```{image} /_static/images/ui/results-saved-navigator-comparison.png
:alt: Saved Results Navigator comparing historical SolutionSet runs and spectral overlays
:align: center
:width: 100%
```

Output parameters outside the stage and result inspectors remain Python-only.
See {doc}`/frontend/capability-register`, {doc}`/frontend/inspectors/analysis-and-frequency-domain`, and {doc}`/frontend/visualization/charts-and-playback`.
Frontend source owners: `apps/control-room/src/modules/inspector/inspectors/study/stages/FftResponseStageSpec.tsx`, `EigenDispersionInspectorPanel`, `DynamicStructureFactorView`, and `SavedResultsBrowser`.

(python-api-outputs-dispersion-and-response-source-code-index)=
## 13. Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| Dispersion output request validation and lowering | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L324) | `class SaveDispersion` | Dispersion output request validation and lowering | Ownership and API contract tests |
| Response output request validation and lowering | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L217) | `class SaveResponse` | Response output request validation and lowering | Ownership and API contract tests |
| Branch tracking across k-paths | [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/eigen/tracking.rs#L1222) | `track_branches` | Mass-weighted Hungarian mode branch tracking | Rust runner source |
