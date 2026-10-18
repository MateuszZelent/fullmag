---
title: Dispersion and Response
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: dispersion-and-response.source-map.json and reviewed source revision 5e99782acbb7fb3f65d0cad872e102bf67733103
---

(public-docs-python-api-outputs-dispersion-and-response)=
# Dispersion and Response

(python-api-outputs-dispersion-and-response-problem-statement)=
<!-- (problem-statement)= -->
## 1. Contract and scope

This page records the dispersion-curve (`SaveDispersion`) and frequency-response (`SaveResponse`)
output descriptors attached to `Eigenmodes` and `FrequencyResponse` studies.

(python-api-outputs-dispersion-and-response-governing-equations)=
<!-- (governing-equations)= -->
## 2. Governing equations

Response and dispersion definitions belong to {doc}`../../numerical-methods/frequency-domain/index`
and {doc}`../../numerical-methods/eigensolvers/index`. `SaveDispersion` publishes $\omega_b(\mathbf k_s)$
and tracked branch tables (`eigen/branches.v2.json` and `eigen/dispersion.csv`), while
`SaveResponse` publishes steady-state dynamic susceptibility and complex response fields
$\delta\mathbf m(\omega)$.

(python-api-outputs-dispersion-and-response-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## 3. Symbols and SI units

Eigenfrequency values are in hertz ($\mathrm{Hz}$), wave vectors in $\mathrm{rad\,m^{-1}}$, and
response observables carry the SI units of their physical definition.

(python-api-outputs-dispersion-and-response-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## 4. Assumptions and validity

Response observable identifiers and dispersion names are validated immediately upon construction and
checked for stage compatibility during planning (`validate_eigen_outputs`).

(python-api-outputs-dispersion-and-response-python-api)=
<!-- (python-api)= -->
## 5. Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SaveDispersion.name` | `str` | `"dispersion"` | $1$ | Non-empty | Curve name | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dispersion_curve.name` |
| `SaveDispersion.include_branch_table` | `bool` | `True` | $1$ | Boolean | Include branch table | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `dispersion_curve.include_branch_table` |
| `SaveResponse.observable` | `str` | `required` | $1$ | One of the supported response observables | Response output | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `frequency_response_output.observable` |

Supported response observables include `susceptibility_tensor`, `m_complex`, `u_complex`,
`strain_complex`, `stress_complex`, `absorbed_power_density`, `response_amplitude`,
`response_phase`, and `mode_hybridization_index`.

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
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
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
<!-- (problem-ir)= -->
## 6. ProblemIR

`SaveDispersion.to_ir()` emits `dispersion_curve`; `SaveResponse.to_ir()` emits
`frequency_response_output`. Both are carried in the study's `sampling.outputs`.

(python-api-outputs-dispersion-and-response-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## 7. Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is
the planner or realization result. Validation errors identify the violated domain rule, and
unsupported combinations are rejected explicitly rather than silently substituted. Unknown response
observables fail immediately; dispersion names are preserved without interpretation.

(python-api-outputs-dispersion-and-response-discrete-realization)=
<!-- (discrete-realization)= -->
## 8. Discrete realization

Response materialization follows the frequency-domain solvers; dispersion follows the modal
eigensolver and `track_branches` (`crates/fullmag-runner/src/eigen/tracking.rs`).

(python-api-outputs-dispersion-and-response-implementation-mapping)=
<!-- (implementation-mapping)= -->
## 9. Implementation mapping

| Class | Repository path | Stable symbol | Responsibility |
|---|---|---|---|
| Dispersion output | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L324) | `class SaveDispersion` | Dispersion curve and branch-table output request |
| Response output | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L217) | `class SaveResponse` | Driven frequency-response observable request |
| Branch tracking | [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | `track_branches` | Mass-weighted Hungarian dispersion branch tracking |

(python-api-outputs-dispersion-and-response-validation)=
<!-- (validation)= -->
## 10. Validation

Ownership tests compare this inventory with live signatures.

(python-api-outputs-dispersion-and-response-limitations)=
<!-- (limitations)= -->
## 11. Limitations

Requesting an output does not guarantee the solver materializes it; planner and solver capability
resolution are authoritative.

(python-api-outputs-dispersion-and-response-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## 12. Scientific bibliography

Definitions belong to {doc}`../../numerical-methods/frequency-domain/index` and
{doc}`../../numerical-methods/eigensolvers/index`.

(python-api-outputs-dispersion-and-response-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Table/field autosave and result inspection are partial; unsupported output formats remain not implemented.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> <stage> -> Outputs` | `partial` | Submit stage draft; output resources are revised after execution |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Outputs` | `not implemented` | Python-only until implemented |

not implemented: frontend support for output parameters not rendered by the autosave/result inspectors.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: [`apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts#L1074) (`buildEigenDispersionChartModel`, `buildFrequencyResponseChartModel`).

## 13. Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Dispersion output request validation and lowering. | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L324) | `class SaveDispersion` | Dispersion output request validation and lowering. | Source-map validator and focused API tests |
| Response output request validation and lowering. | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/outputs.py#L217) | `class SaveResponse` | Response output request validation and lowering. | Source-map validator and focused API tests |
| Branch tracking across k-paths. | [`crates/fullmag-runner/src/eigen/tracking.rs`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/crates/fullmag-runner/src/eigen/tracking.rs#L1217) | `track_branches` | Mass-weighted Hungarian mode branch tracking. | Rust runner source |
